/**
 * Audio capture with echo cancellation, dynamic VAD, instant interrupt,
 * and pre-buffer to capture the start of speech.
 *
 * Key design:
 * - A rolling pre-buffer (800ms) records continuously so we never miss
 *   the first words when the user starts speaking
 * - When VAD confirms speech, the pre-buffer is prepended to the recording
 * - Dynamic threshold calibrates to echo bleed when AI speaks
 * - Instant local mute (~1ms) before any WebSocket round-trip
 */
import { API_PREFIX } from '@interactive-reviewer/shared';
import { useAudioStore } from '../state/audio-store.js';

export interface AudioCaptureCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onTranscript: (text: string) => void;
  onError: (error: string) => void;
  onStateChange: (state: string) => void;
}

// VAD config
const VAD_POLL_MS = 20;
const BASE_THRESHOLD = 12;
const MIN_SPEAKING_THRESHOLD = 30;
const ECHO_THRESHOLD_MULTIPLIER = 2.5;
const ECHO_CALIBRATION_MS = 500;
const CONFIRM_SPEECH_MS = 100;         // Reduced from 200ms — pre-buffer catches early words
const SILENCE_TIMEOUT_MS = 1200;
const MIN_RECORDING_MS = 300;
const PRE_BUFFER_MS = 800;             // Rolling buffer captures last 800ms

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private isCapturing = false;
  private isSpeaking = false;
  private isMuted = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private speechStartTime = 0;
  private vadInterval: ReturnType<typeof setInterval> | null = null;
  private callbacks: AudioCaptureCallbacks;

  // Pre-buffer: continuously records, keeps last PRE_BUFFER_MS
  private preBufferRecorder: MediaRecorder | null = null;
  private preBufferChunks: Blob[] = [];
  private preBufferStartTime = 0;

  // Main speech recorder
  private speechRecorder: MediaRecorder | null = null;
  private speechChunks: Blob[] = [];

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
        },
      });

      this.audioContext = new AudioContext();
      const source = this.audioContext.createMediaStreamSource(this.stream);
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      source.connect(this.analyser);

      this.isCapturing = true;

      // Start the rolling pre-buffer
      this.startPreBuffer();

      // Start VAD
      this.startVAD();

      // Subscribe to playback state changes for dynamic threshold
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
    }
  }

  stop(): void {
    this.isCapturing = false;
    if (this.vadInterval) { clearInterval(this.vadInterval); this.vadInterval = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.confirmTimer) { clearTimeout(this.confirmTimer); this.confirmTimer = null; }
    if (this.echoCalibrationTimer) { clearTimeout(this.echoCalibrationTimer); this.echoCalibrationTimer = null; }
    this.stopPreBuffer();
    if (this.speechRecorder && this.speechRecorder.state !== 'inactive') { this.speechRecorder.stop(); }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
  }

  // --- Pre-buffer: continuously records the last 800ms ---

  private startPreBuffer(): void {
    if (!this.stream) return;

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    this.preBufferRecorder = new MediaRecorder(this.stream, { mimeType });
    this.preBufferChunks = [];
    this.preBufferStartTime = Date.now();

    this.preBufferRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.preBufferChunks.push(e.data);
        // Trim to keep only the last PRE_BUFFER_MS worth of chunks
        // Each chunk is ~100ms, so keep last 8 chunks
        const maxChunks = Math.ceil(PRE_BUFFER_MS / 100);
        if (this.preBufferChunks.length > maxChunks) {
          this.preBufferChunks = this.preBufferChunks.slice(-maxChunks);
        }
      }
    };

    this.preBufferRecorder.start(100); // 100ms timeslices
  }

  private stopPreBuffer(): void {
    if (this.preBufferRecorder && this.preBufferRecorder.state !== 'inactive') {
      this.preBufferRecorder.stop();
    }
    this.preBufferRecorder = null;
    this.preBufferChunks = [];
  }

  private getPreBufferBlob(): Blob {
    // Return a copy of the current pre-buffer
    const mimeType = this.preBufferChunks[0]?.type ?? 'audio/webm';
    return new Blob([...this.preBufferChunks], { type: mimeType });
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

  // --- Voice Activity Detection ---

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

      if (this.echoCalibrating) {
        this.echoSamples.push(rms);
        return;
      }

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
    const store = useAudioStore.getState();

    // Instant mute
    if (store.isPlaying && !this.isMuted) {
      store.muteOutput();
      this.isMuted = true;
    }

    // Start confirmation timer
    if (!this.confirmTimer) {
      this.confirmTimer = setTimeout(() => {
        this.confirmTimer = null;
        this.isSpeaking = true;
        this.speechStartTime = Date.now();
        this.callbacks.onSpeechStart();

        // Grab the pre-buffer (captures the first ~800ms of speech we'd otherwise miss)
        // then start the main recorder
        this.startSpeechRecording();
      }, CONFIRM_SPEECH_MS);
    }
  }

  private onSilenceDetected(): void {
    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;
      this.isMuted = false;
      return;
    }

    if (this.silenceTimer) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.isSpeaking = false;
      this.callbacks.onSpeechEnd();
      if (this.speechRecorder && this.speechRecorder.state !== 'inactive') {
        this.speechRecorder.stop();
      }
    }, SILENCE_TIMEOUT_MS);
  }

  // --- Recording (with pre-buffer) ---

  private startSpeechRecording(): void {
    if (!this.stream) return;

    // Snapshot the pre-buffer BEFORE starting the new recorder
    const preBuffer = this.getPreBufferBlob();

    this.speechChunks = [];
    // Store pre-buffer as the first chunk — it contains the start of speech
    if (preBuffer.size > 0) {
      this.speechChunks.push(preBuffer);
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    this.speechRecorder = new MediaRecorder(this.stream, { mimeType });
    this.speechRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.speechChunks.push(e.data);
    };
    this.speechRecorder.onstop = () => {
      this.processRecording();
    };
    this.speechRecorder.start(100);
  }

  private async processRecording(): Promise<void> {
    const duration = Date.now() - this.speechStartTime;
    this.isMuted = false;

    if (duration < MIN_RECORDING_MS || this.speechChunks.length === 0) {
      return;
    }

    // Combine pre-buffer + speech chunks into one blob
    const mimeType = this.speechChunks[0]?.type ?? 'audio/webm';
    const blob = new Blob(this.speechChunks, { type: mimeType });
    this.speechChunks = [];

    try {
      const wavBlob = await this.webmToWav(blob);
      const response = await fetch(`${API_PREFIX}/audio/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wavBlob,
      });

      if (!response.ok) {
        this.callbacks.onError('Transcription failed');
        return;
      }

      const result = await response.json() as { text: string };
      if (result.text && result.text.trim()) {
        this.callbacks.onTranscript(result.text.trim());
      }
    } catch (err: any) {
      this.callbacks.onError(`Transcription error: ${err.message}`);
    }
  }

  private async webmToWav(webmBlob: Blob): Promise<Blob> {
    const arrayBuffer = await webmBlob.arrayBuffer();
    const audioCtx = new AudioContext({ sampleRate: 16000 });
    try {
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const channelData = audioBuffer.getChannelData(0);
      const wavBuffer = encodeWav(channelData, 16000);
      return new Blob([wavBuffer], { type: 'audio/wav' });
    } finally {
      audioCtx.close();
    }
  }
}

function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return buffer;
}

function writeString(view: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
