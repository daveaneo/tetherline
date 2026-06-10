/**
 * Voice interaction metrics. Reads a trace timeline of voice-related events
 * and produces objective numbers measuring how well the AI handles
 * interruption (by user) and how well it avoids interrupting itself.
 *
 * All times are milliseconds. All metrics are deterministic functions of the
 * trace — so a fix's impact is directly visible in the numbers.
 */
import type { TraceEvent } from '../dev/trace.js';

export interface VoiceMetrics {
  /** How fast does the AI stop speaking after the user begins?
   *  Target: <100ms (feels instant). Tier: <250ms (acceptable).
   *  null if no user speaking event in the trace. */
  timeToFlushMs: number | null;

  /** Count of narration events emitted by the server between the user
   *  starting to speak and stopping. Target: 0. Any positive number means
   *  the server kept generating while the user held the floor. */
  emitsDuringUserSpeech: number;

  /** Count of narration events emitted AFTER the user started speaking but
   *  BEFORE the queue was flushed. These are queue leaks. Target: 0. */
  emitsBeforeFlush: number;

  /** From `user.speaking_stopped` to the next `tts.emit`.
   *  Target: 400-1500ms (natural conversational gap).
   *  <200ms = cutting off (AI jumped in too fast).
   *  >2000ms = laggy. */
  timeToRespondMs: number | null;

  /** Number of times a new tts.emit happened while a previous emit's segment
   *  was still considered "in progress" on the client. Target: 0.
   *  (AI interrupting itself.) */
  selfInterrupts: number;

  /** Total ms of concurrent TTS + user voice activity.
   *  Target: <100ms per barge-in (post-flush tail only). */
  overlapMs: number;

  /** Whether the server emitted a `tts.queue_flush` at all after a user
   *  speaking event. false = no flush happened (bug). */
  flushed: boolean;

  /** From the first `utterance.received` to the first stream-chunk
   *  `tts.emit` at-or-after it — i.e. did the spoken ack actually reach
   *  the client, and how fast? null when the trace has no utterance OR
   *  the ack never made it out (the pre-fix floor gate DROPPED acks that
   *  landed inside the post-user-silence window). */
  ackDeliveredMs: number | null;
  /** Number of utterance.received events (lets reports distinguish
   *  "no ack because no utterance" from "ack dropped"). */
  utteranceCount: number;
  /** Count of `tts.hold` events — current-turn chunks held (not dropped)
   *  while the user held the floor. */
  heldCount: number;
  /** Count of `tts.discard_pending` events — held turns superseded by the
   *  user speaking again. */
  discardedPending: number;
}

export interface ScenarioTrace {
  events: TraceEvent[];
  /** Wall-clock offset applied during analysis to make latencies relative. */
  originMs: number;
}

/** Compute voice metrics for a single exchange captured in `events`. */
export function computeVoiceMetrics(events: TraceEvent[]): VoiceMetrics {
  const voiceEvents = events.filter(e =>
    e.kind === 'user.speaking_started' ||
    e.kind === 'user.speaking_stopped' ||
    e.kind === 'tts.emit' ||
    e.kind === 'tts.queue_flush' ||
    e.kind === 'tts.hold' ||
    e.kind === 'tts.discard_pending' ||
    e.kind === 'utterance.received' ||
    e.kind === 'audio.segment_started' ||
    e.kind === 'audio.segment_ended',
  );

  const firstSpeakingStart = voiceEvents.find(e => e.kind === 'user.speaking_started');
  const firstSpeakingStop = voiceEvents.find(e => e.kind === 'user.speaking_stopped'
    && firstSpeakingStart && e.ts > firstSpeakingStart.ts);

  const startTs = firstSpeakingStart ? Date.parse(firstSpeakingStart.ts) : null;
  const stopTs = firstSpeakingStop ? Date.parse(firstSpeakingStop.ts) : null;

  // time_to_flush: earliest tts.queue_flush after user.speaking_started
  let timeToFlushMs: number | null = null;
  let flushed = false;
  if (startTs !== null) {
    const flush = voiceEvents.find(e => e.kind === 'tts.queue_flush' && Date.parse(e.ts) >= startTs);
    if (flush) {
      timeToFlushMs = Date.parse(flush.ts) - startTs;
      flushed = true;
    }
  }

  // emits_during_user_speech + emits_before_flush
  let emitsDuringUserSpeech = 0;
  let emitsBeforeFlush = 0;
  if (startTs !== null) {
    const endBound = stopTs ?? Number.POSITIVE_INFINITY;
    const flushTs = flushed && timeToFlushMs !== null ? startTs + timeToFlushMs : null;
    for (const e of voiceEvents) {
      if (e.kind !== 'tts.emit') continue;
      const t = Date.parse(e.ts);
      if (t >= startTs && t <= endBound) emitsDuringUserSpeech += 1;
      if (flushTs !== null && t >= startTs && t <= flushTs) emitsBeforeFlush += 1;
    }
  }

  // time_to_respond: first tts.emit after user.speaking_stopped
  let timeToRespondMs: number | null = null;
  if (stopTs !== null) {
    const next = voiceEvents.find(e => e.kind === 'tts.emit' && Date.parse(e.ts) >= stopTs);
    if (next) timeToRespondMs = Date.parse(next.ts) - stopTs;
  }

  // self_interrupts: a new tts.emit fires while audio.segment_started is
  // still "open" (no matching audio.segment_ended yet). Counts only when we
  // know a segment is actively playing — otherwise the metric is dominated
  // by the test framework not ack'ing segment lifecycle.
  let selfInterrupts = 0;
  let audioActive = false;
  for (const e of voiceEvents) {
    if (e.kind === 'audio.segment_started') audioActive = true;
    else if (e.kind === 'audio.segment_ended') audioActive = false;
    else if (e.kind === 'tts.emit' && audioActive) selfInterrupts += 1;
  }

  // overlap_ms: sum of intervals where both user was speaking AND an audio
  // segment was in progress. Computed from audio.segment_started and
  // audio.segment_ended events interleaved with user speaking windows.
  let overlapMs = 0;
  const speakingWindows: Array<[number, number]> = [];
  let ws: number | null = null;
  for (const e of voiceEvents) {
    if (e.kind === 'user.speaking_started') ws = Date.parse(e.ts);
    else if (e.kind === 'user.speaking_stopped' && ws !== null) {
      speakingWindows.push([ws, Date.parse(e.ts)]);
      ws = null;
    }
  }
  if (ws !== null) speakingWindows.push([ws, Date.now()]);

  const audioWindows: Array<[number, number]> = [];
  let as: number | null = null;
  for (const e of voiceEvents) {
    if (e.kind === 'audio.segment_started') as = Date.parse(e.ts);
    else if (e.kind === 'audio.segment_ended' && as !== null) {
      audioWindows.push([as, Date.parse(e.ts)]);
      as = null;
    }
  }
  for (const [s1, e1] of speakingWindows) {
    for (const [s2, e2] of audioWindows) {
      const overlapStart = Math.max(s1, s2);
      const overlapEnd = Math.min(e1, e2);
      if (overlapEnd > overlapStart) overlapMs += overlapEnd - overlapStart;
    }
  }

  // ack_delivered: first utterance → first stream-chunk emit after it.
  // The seq-0 ack leads every turn stream, so the first stream-chunk emit
  // after the utterance IS the ack reaching the client.
  const firstUtterance = voiceEvents.find(e => e.kind === 'utterance.received');
  let ackDeliveredMs: number | null = null;
  if (firstUtterance) {
    const ut = Date.parse(firstUtterance.ts);
    const ackEmit = voiceEvents.find(e =>
      e.kind === 'tts.emit' &&
      (e.payload as { eventType?: string } | undefined)?.eventType === 'narration:stream_chunk' &&
      Date.parse(e.ts) >= ut,
    );
    if (ackEmit) ackDeliveredMs = Date.parse(ackEmit.ts) - ut;
  }

  return {
    timeToFlushMs,
    emitsDuringUserSpeech,
    emitsBeforeFlush,
    timeToRespondMs,
    selfInterrupts,
    overlapMs,
    flushed,
    ackDeliveredMs,
    utteranceCount: voiceEvents.filter(e => e.kind === 'utterance.received').length,
    heldCount: voiceEvents.filter(e => e.kind === 'tts.hold').length,
    discardedPending: voiceEvents.filter(e => e.kind === 'tts.discard_pending').length,
  };
}

/** Evaluate metrics against conventional targets; returns pass/fail per metric. */
export function scoreMetrics(m: VoiceMetrics): Record<keyof VoiceMetrics, 'pass' | 'warn' | 'fail' | 'n/a'> {
  return {
    timeToFlushMs: m.timeToFlushMs === null ? 'n/a'
      : m.timeToFlushMs <= 100 ? 'pass'
      : m.timeToFlushMs <= 250 ? 'warn'
      : 'fail',
    emitsDuringUserSpeech: m.emitsDuringUserSpeech === 0 ? 'pass'
      : m.emitsDuringUserSpeech <= 1 ? 'warn'
      : 'fail',
    emitsBeforeFlush: m.emitsBeforeFlush === 0 ? 'pass' : 'fail',
    timeToRespondMs: m.timeToRespondMs === null ? 'n/a'
      : m.timeToRespondMs >= 400 && m.timeToRespondMs <= 1500 ? 'pass'
      : m.timeToRespondMs < 400 ? 'fail' // cut-off — AI jumped in too fast
      : m.timeToRespondMs <= 2500 ? 'warn'
      : 'fail',
    selfInterrupts: m.selfInterrupts === 0 ? 'pass' : 'fail',
    overlapMs: m.overlapMs <= 100 ? 'pass'
      : m.overlapMs <= 300 ? 'warn'
      : 'fail',
    flushed: m.flushed ? 'pass' : 'fail' as any,
    // Quick commands answer without an ack stream, so a missing ack is
    // only conclusively a failure when held chunks prove a turn stream
    // existed (it was held but never released = dropped/discarded turn).
    ackDeliveredMs: m.utteranceCount === 0 ? 'n/a'
      : m.ackDeliveredMs === null ? (m.heldCount > 0 && m.discardedPending === 0 ? 'fail' : 'n/a')
      : m.ackDeliveredMs <= 2000 ? 'pass'
      : 'warn',
    utteranceCount: 'n/a',
    heldCount: 'n/a',
    discardedPending: 'n/a',
  };
}
