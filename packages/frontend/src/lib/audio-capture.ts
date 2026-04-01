/**
 * Audio capture with echo cancellation, dynamic VAD, instant interrupt,
 * and pre-buffer to capture the start of speech.
 *
 * Architecture: ONE MediaRecorder runs continuously. Chunks are collected
 * into a rolling buffer. When speech is confirmed, we keep ALL chunks
 * from the buffer (pre-speech) plus new chunks (during speech) and send
 * them as a single valid WebM blob to Whisper.
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

const VAD_POLL_MS = 20;
const BASE_THRESHOLD = 12;
const MIN_SPEAKING_THRESHOLD = 30;
const ECHO_THRESHOLD_MULTIPLIER = 2.5;
const ECHO_CALIBRATION_MS = 500;
const CONFIRM_SPEECH_MS = 100;
const SILENCE_TIMEOUT_MS = 1200;
const MIN_RECORDING_MS = 300;
const PRE_BUFFER_CHUNKS = 8; // Keep last 8 chunks (~800ms at 100ms each)

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private isCapturing = false;
  private isSpeaking = false;
  private isMuted = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private speechStartTime = 0;
  private vadInterval: ReturnType<typeof setInterval> | null = null;
  private callbacks: AudioCaptureCallbacks;

  // Single chunk buffer — rolling when idle, collecting during speech
  private allChunks: Blob[] = [];
  private speechStartChunkIndex = 0;
  private isRecordingSpeech = false;

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
      this.startContinuousRecording();
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
    }
  }

  stop(): void {
    this.isCapturing = false;
    if (this.vadInterval) { clearInterval(this.vadInterval); this.vadInterval = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.confirmTimer) { clearTimeout(this.confirmTimer); this.confirmTimer = null; }
    if (this.echoCalibrationTimer) { clearTimeout(this.echoCalibrationTimer); this.echoCalibrationTimer = null; }
    if (this.recorder && this.recorder.state !== 'inactive') { this.recorder.stop(); }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
  }

  // --- Single continuous recorder ---

  private startContinuousRecording(): void {
    if (!this.stream) return;

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    this.recorder = new MediaRecorder(this.stream, { mimeType });
    this.allChunks = [];

    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        this.allChunks.push(e.data);

        // When idle (not recording speech), trim the buffer to keep only recent chunks
        if (!this.isRecordingSpeech) {
          if (this.allChunks.length > PRE_BUFFER_CHUNKS) {
            this.allChunks = this.allChunks.slice(-PRE_BUFFER_CHUNKS);
          }
        }
      }
    };

    this.recorder.start(100); // 100ms timeslices
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
    if (store.isPlaying && !this.isMuted) {
      store.muteOutput();
      this.isMuted = true;
    }

    if (!this.confirmTimer) {
      this.confirmTimer = setTimeout(() => {
        this.confirmTimer = null;
        this.isSpeaking = true;
        this.isRecordingSpeech = true;
        this.speechStartTime = Date.now();
        // Mark where speech starts — we keep all chunks from
        // (current position - PRE_BUFFER_CHUNKS) onward
        this.speechStartChunkIndex = Math.max(0, this.allChunks.length - PRE_BUFFER_CHUNKS);
        this.callbacks.onSpeechStart();
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
      this.isRecordingSpeech = false;
      this.callbacks.onSpeechEnd();
      this.processSpeechChunks();
    }, SILENCE_TIMEOUT_MS);
  }

  // --- Processing ---

  private async processSpeechChunks(): Promise<void> {
    const duration = Date.now() - this.speechStartTime;
    this.isMuted = false;

    if (duration < MIN_RECORDING_MS) return;

    // Extract speech chunks: from speechStartChunkIndex to current end
    const speechChunks = this.allChunks.slice(this.speechStartChunkIndex);
    if (speechChunks.length === 0) return;

    // Reset buffer — keep only the last few chunks for next pre-buffer
    this.allChunks = this.allChunks.slice(-PRE_BUFFER_CHUNKS);

    // Build a single valid WebM blob from the continuous recorder's chunks
    const mimeType = speechChunks[0]?.type ?? 'audio/webm';
    const blob = new Blob(speechChunks, { type: mimeType });

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
