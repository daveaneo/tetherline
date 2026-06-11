/**
 * Audio capture with echo cancellation, dynamic VAD, instant interrupt,
 * and pre-buffer. Uses raw PCM capture (not MediaRecorder) to avoid
 * WebM encoding issues.
 *
 * Records raw Float32 samples via ScriptProcessorNode, keeps a rolling
 * buffer, and encodes to WAV on speech end for Whisper transcription.
 */
import { API_PREFIX } from '@tetherline/shared';
import { useAudioStore } from '../state/audio-store.js';

export interface AudioCaptureCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onTranscript: (text: string) => void;
  onError: (error: string) => void;
  onStateChange: (state: string) => void;
  /** A speech episode ended with NO usable transcript (too short, encoder
   *  floor, HTTP failure, empty text). The consumer uses this to resume
   *  floor-paused playback — the sound wasn't real user speech. */
  onSpeechDiscarded?: () => void;
}

const VAD_POLL_MS = 20;
const BASE_THRESHOLD = 12;
const MIN_SPEAKING_THRESHOLD = 30;
const ECHO_THRESHOLD_MULTIPLIER = 2.5;
const ECHO_CALIBRATION_MS = 500;
const CONFIRM_SPEECH_MS = 100;
const SILENCE_TIMEOUT_MS = 1200;
const MIN_RECORDING_MS = 300;
const SAMPLE_RATE = 16000;
const PRE_BUFFER_SECONDS = 0.8;
const PRE_BUFFER_SAMPLES = SAMPLE_RATE * PRE_BUFFER_SECONDS;

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private isCapturing = false;
  private isSpeaking = false;
  /** Monotonic speech-episode counter. Discard/resume handlers no-op when a
   *  newer episode has started (guards the resume-vs-new-speech race). */
  private episodeId = 0;
  /** True while a Whisper POST is in flight — blocks noise-rollback resume
   *  so a pending real transcript can't race a wrongful playback resume. */
  private transcribing = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private speechStartTime = 0;
  private vadInterval: ReturnType<typeof setInterval> | null = null;
  private callbacks: AudioCaptureCallbacks;

  // Raw PCM buffer — rolling when idle, collecting during speech
  private pcmBuffer: Float32Array[] = [];
  private pcmSampleCount = 0;
  private isRecordingSpeech = false;
  private speechStartSampleCount = 0;
  /** True between forceSpeechStart and forceSpeechEnd. While held, the
   *  VAD's silence-detection MUST NOT call processSpeech — otherwise a
   *  single PTT hold gets sliced into N partial transcripts at every
   *  natural pause (breath, thinking gap), each routed as a separate
   *  question. The user explicitly told us "I'm speaking now" by holding
   *  space; trust that, and only ship audio at release. */
  private pttHeld = false;

  // Dynamic threshold
  private dynamicThreshold = BASE_THRESHOLD;
  private echoCalibrating = false;
  private echoSamples: number[] = [];
  private echoCalibrationTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(callbacks: AudioCaptureCallbacks) {
    this.callbacks = callbacks;
  }

  async start(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: SAMPLE_RATE,
        },
      });

      this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
      const source = this.audioContext.createMediaStreamSource(this.stream);

      // Analyser for VAD
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);

      // ScriptProcessor to capture raw PCM samples
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (e) => {
        if (!this.isCapturing) return;
        const input = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        this.pcmBuffer.push(copy);
        this.pcmSampleCount += copy.length;

        // When idle, trim to keep only the pre-buffer
        if (!this.isRecordingSpeech) {
          while (this.pcmSampleCount > PRE_BUFFER_SAMPLES * 2 && this.pcmBuffer.length > 2) {
            const removed = this.pcmBuffer.shift()!;
            this.pcmSampleCount -= removed.length;
          }
        }
      };
      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination); // required for processing to run

      this.isCapturing = true;
      this.startVAD();

      useAudioStore.subscribe((state) => {
        if (state.isPlaying && !this.echoCalibrating) {
          this.startEchoCalibration();
        } else if (!state.isPlaying) {
          this.stopEchoCalibration();
          this.dynamicThreshold = BASE_THRESHOLD;
        }
      });

      this.callbacks.onStateChange('capture_started');
    } catch (err: any) {
      this.callbacks.onError(`Mic access failed: ${err.message}`);
      // Rethrow so the CALLER's promise rejects too — useVoiceInput's
      // start path tears down (`setListening(false)`) in its .catch.
      // Swallowing here left that teardown dead code: a denied mic
      // showed a green "Mic on" while nothing was being captured.
      throw err;
    }
  }

  stop(): void {
    this.isCapturing = false;
    if (this.vadInterval) { clearInterval(this.vadInterval); this.vadInterval = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.confirmTimer) { clearTimeout(this.confirmTimer); this.confirmTimer = null; }
    if (this.echoCalibrationTimer) { clearTimeout(this.echoCalibrationTimer); this.echoCalibrationTimer = null; }
    if (this.processor) { this.processor.disconnect(); this.processor = null; }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
  }

  /** PTT-only: mark the start of an explicit recording window, bypassing
   *  VAD. VAD-driven flow requires onSoundDetected → confirmTimer →
   *  isRecordingSpeech=true to fire before audio is retained — but a
   *  PTT user already told us "I'm speaking" by holding space. Calling
   *  this immediately starts retaining audio into pcmBuffer (without
   *  the trim-to-pre-buffer logic that runs while !isRecordingSpeech). */
  forceSpeechStart(): void {
    if (!this.isCapturing) return;
    this.isSpeaking = true;
    this.isRecordingSpeech = true;
    this.pttHeld = true;
    this.episodeId++;
    // Cancel any in-flight VAD silence timer so a pre-existing
    // segmentation can't fire after we entered PTT mode.
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.confirmTimer) { clearTimeout(this.confirmTimer); this.confirmTimer = null; }
    this.speechStartTime = Date.now();
    this.speechStartSampleCount = Math.max(0, this.pcmSampleCount - PRE_BUFFER_SAMPLES);
  }

  /** PTT-only: explicitly end the recording window and ship the buffer
   *  to Whisper. Returns the transcript promise so callers can await it
   *  before tearing down the capture stream. VAD never had to fire. */
  async forceSpeechEnd(): Promise<void> {
    if (!this.isRecordingSpeech) return;
    this.isSpeaking = false;
    this.isRecordingSpeech = false;
    this.pttHeld = false;
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.confirmTimer) { clearTimeout(this.confirmTimer); this.confirmTimer = null; }
    await this.processSpeech();
  }

  // --- Echo calibration ---

  private startEchoCalibration(): void {
    this.echoCalibrating = true;
    this.echoSamples = [];
    this.echoCalibrationTimer = setTimeout(() => {
      this.echoCalibrating = false;
      if (this.echoSamples.length > 0) {
        const avgBleed = this.echoSamples.reduce((a, b) => a + b, 0) / this.echoSamples.length;
        this.dynamicThreshold = Math.max(avgBleed * ECHO_THRESHOLD_MULTIPLIER, MIN_SPEAKING_THRESHOLD);
      } else {
        this.dynamicThreshold = MIN_SPEAKING_THRESHOLD;
      }
    }, ECHO_CALIBRATION_MS);
  }

  private stopEchoCalibration(): void {
    this.echoCalibrating = false;
    if (this.echoCalibrationTimer) { clearTimeout(this.echoCalibrationTimer); this.echoCalibrationTimer = null; }
    this.echoSamples = [];
  }

  // --- VAD ---

  private startVAD(): void {
    if (!this.analyser) return;
    const dataArray = new Uint8Array(this.analyser.frequencyBinCount);

    this.vadInterval = setInterval(() => {
      if (!this.analyser || !this.isCapturing) return;
      this.analyser.getByteTimeDomainData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const val = (dataArray[i] - 128) / 128;
        sum += val * val;
      }
      const rms = Math.sqrt(sum / dataArray.length) * 100;

      if (this.echoCalibrating) { this.echoSamples.push(rms); return; }

      const threshold = this.dynamicThreshold;
      if (!this.isSpeaking && rms > threshold) {
        this.onSoundDetected();
      } else if (this.isSpeaking && rms < threshold * 0.6) {
        this.onSilenceDetected();
      } else if (this.isSpeaking && rms >= threshold * 0.6) {
        if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
      }
    }, VAD_POLL_MS);
  }

  private onSoundDetected(): void {
    // While the user is holding PTT, VAD must NOT auto-segment. The
    // user explicitly told us when speech started (forceSpeechStart);
    // a re-trigger here would needlessly reset speechStartSampleCount
    // and could discard pre-buffer audio.
    if (this.pttHeld) return;

    // Duck, don't kill: soft-pause AI playback the instant sound crosses
    // the threshold. The mission is ZERO talk-over — even the 100ms
    // confirm window is overlap. If the sound turns out to be noise the
    // pause is resumable (the old muteOutput hard-stop was not, which
    // made every false trigger destroy the rest of the clip). During
    // playback the threshold is echo-calibrated to 2.5x measured bleed,
    // so crossings here are rare and loud.
    useAudioStore.getState().duckForFloor();

    if (!this.confirmTimer) {
      this.confirmTimer = setTimeout(() => {
        this.confirmTimer = null;
        this.isSpeaking = true;
        this.isRecordingSpeech = true;
        this.episodeId++;
        this.speechStartTime = Date.now();
        // Mark where speech starts in the PCM buffer (include pre-buffer)
        this.speechStartSampleCount = Math.max(0, this.pcmSampleCount - PRE_BUFFER_SAMPLES);
        useAudioStore.getState().confirmFloor();
        this.callbacks.onSpeechStart();
      }, CONFIRM_SPEECH_MS);
    }
  }

  private onSilenceDetected(): void {
    // While the user is holding PTT, VAD silence detection MUST NOT fire
    // processSpeech. Otherwise a single hold gets sliced into N partial
    // transcripts at every natural pause (breath, thinking gap), each
    // routed to the backend as a separate question. Confirmed in the
    // trace: one PTT hold produced "Alright. Personal." / "or is a pipe.
    // All right I want you to..." / "using 10 words." / "it should be a
    // pole." — four fragments fired four wrong skill calls.
    // Only forceSpeechEnd (PTT release) ships audio in PTT mode.
    if (this.pttHeld) return;

    if (this.confirmTimer) {
      // Sound died inside the 100ms confirm window — a blip, not speech.
      // Roll the provisional duck back so playback continues with only a
      // ~150ms hiccup. Never resume while a transcription is in flight:
      // the floor still belongs to the previous (real) episode.
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
      if (!this.transcribing) {
        useAudioStore.getState().resumeFromFloor('noise');
      }
      return;
    }

    if (this.silenceTimer) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.isSpeaking = false;
      this.isRecordingSpeech = false;
      this.callbacks.onSpeechEnd();
      this.processSpeech();
    }, SILENCE_TIMEOUT_MS);
  }

  // --- Process speech: encode PCM to WAV and send to Whisper ---

  private async processSpeech(): Promise<void> {
    const duration = Date.now() - this.speechStartTime;
    const episode = this.episodeId;
    // Fires the no-transcript signal unless a newer speech episode has
    // already begun (its own resolution owns the floor then).
    const discard = () => {
      if (episode === this.episodeId) this.callbacks.onSpeechDiscarded?.();
    };

    if (duration < MIN_RECORDING_MS) {
      this.pcmBuffer = [];
      this.pcmSampleCount = 0;
      discard();
      return;
    }

    // Concatenate all PCM chunks into one Float32Array
    const totalSamples = this.pcmBuffer.reduce((s, c) => s + c.length, 0);
    const allSamples = new Float32Array(totalSamples);
    let offset = 0;
    for (const chunk of this.pcmBuffer) {
      allSamples.set(chunk, offset);
      offset += chunk.length;
    }

    // Clear buffer for next round
    this.pcmBuffer = [];
    this.pcmSampleCount = 0;

    if (allSamples.length < SAMPLE_RATE * 0.3) { discard(); return; } // less than 300ms

    // Encode to WAV
    const wavBlob = encodeWavBlob(allSamples, SAMPLE_RATE);

    try {
      this.transcribing = true;
      const response = await fetch(`${API_PREFIX}/audio/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wavBlob,
      });

      if (!response.ok) {
        // Surface the upstream cause when the backend gives one.
        // Previously this swallowed every failure into a bare
        // "Transcription failed" — the user had to grep server logs to
        // discover the actual reason (missing faster_whisper module,
        // model load error, etc.). Now the real text reaches the toast.
        let detail = '';
        try {
          const body = await response.clone().json() as { upstream?: string; error?: string };
          detail = body.upstream ?? body.error ?? '';
        } catch {
          try { detail = await response.text(); } catch { /* ignore */ }
        }
        this.callbacks.onError(detail ? `Transcription failed: ${detail}` : 'Transcription failed');
        discard();
        return;
      }

      const result = await response.json() as { text: string };
      if (result.text && result.text.trim()) {
        this.callbacks.onTranscript(result.text.trim());
      } else {
        discard();
      }
    } catch (err: any) {
      this.callbacks.onError(`Transcription error: ${err.message}`);
      discard();
    } finally {
      this.transcribing = false;
    }
  }
}

// --- WAV encoding ---

function encodeWavBlob(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  // RIFF header
  writeStr(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(view, 8, 'WAVE');

  // fmt chunk
  writeStr(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);

  // data chunk
  writeStr(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

function writeStr(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
