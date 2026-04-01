/**
 * Audio capture with echo cancellation, dynamic VAD, and instant interrupt.
 *
 * Key design: sub-20ms interrupt latency.
 * - When the AI is speaking, we raise the mic threshold above the echo bleed level
 * - The instant the user's voice exceeds that threshold, we mute the AI (volume=0) LOCALLY
 *   before any WebSocket round-trip
 * - If the sound persists 200ms, we formally pause and start Whisper recording
 * - If it stops within 200ms (cough, noise), we unmute and continue
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
const VAD_POLL_MS = 20;              // Poll every 20ms (fast detection)
const BASE_THRESHOLD = 12;            // RMS threshold when AI is silent
const MIN_SPEAKING_THRESHOLD = 30;    // Minimum threshold when AI is speaking
const ECHO_THRESHOLD_MULTIPLIER = 2.5; // How far above echo bleed the user must be
const ECHO_CALIBRATION_MS = 500;      // How long to sample echo bleed
const CONFIRM_SPEECH_MS = 200;        // Sound must persist this long to be "real speech"
const SILENCE_TIMEOUT_MS = 1200;      // Silence this long ends recording
const MIN_RECORDING_MS = 300;         // Minimum recording duration to transcribe

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private isCapturing = false;
  private isSpeaking = false;
  private isMuted = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private confirmTimer: ReturnType<typeof setTimeout> | null = null;
  private speechStartTime = 0;
  private vadInterval: ReturnType<typeof setInterval> | null = null;
  private callbacks: AudioCaptureCallbacks;

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
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') { this.mediaRecorder.stop(); }
    if (this.stream) { this.stream.getTracks().forEach(t => t.stop()); this.stream = null; }
    if (this.audioContext) { this.audioContext.close(); this.audioContext = null; }
  }

  // --- Echo calibration: measure bleed level when AI speaks ---

  private startEchoCalibration(): void {
    this.echoCalibrating = true;
    this.echoSamples = [];

    // Sample for ECHO_CALIBRATION_MS, then compute threshold
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

      // Calculate RMS volume
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        const val = (dataArray[i] - 128) / 128;
        sum += val * val;
      }
      const rms = Math.sqrt(sum / dataArray.length) * 100;

      // If calibrating echo, collect samples
      if (this.echoCalibrating) {
        this.echoSamples.push(rms);
        return; // Don't trigger during calibration
      }

      const threshold = this.dynamicThreshold;

      if (!this.isSpeaking && rms > threshold) {
        this.onSoundDetected(rms);
      } else if (this.isSpeaking && rms < threshold * 0.6) {
        this.onSilenceDetected();
      } else if (this.isSpeaking && rms >= threshold * 0.6) {
        // Still speaking — reset silence timer
        if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
      }
    }, VAD_POLL_MS);
  }

  private onSoundDetected(rms: number): void {
    // INSTANT MUTE: kill AI audio locally before anything else (~1ms)
    const store = useAudioStore.getState();
    if (store.isPlaying && !this.isMuted) {
      store.muteOutput();
      this.isMuted = true;
    }

    // Start confirmation timer — if sound persists, it's real speech
    if (!this.confirmTimer) {
      this.confirmTimer = setTimeout(() => {
        this.confirmTimer = null;
        // Sound persisted — this is real speech
        this.isSpeaking = true;
        this.speechStartTime = Date.now();
        this.callbacks.onSpeechStart();
        this.startRecording();
      }, CONFIRM_SPEECH_MS);
    }
  }

  private onSilenceDetected(): void {
    // If we haven't confirmed speech yet, cancel and unmute
    if (this.confirmTimer) {
      clearTimeout(this.confirmTimer);
      this.confirmTimer = null;

      // It was just noise — unmute the AI
      if (this.isMuted) {
        useAudioStore.getState().unmuteOutput();
        this.isMuted = false;
      }
      return;
    }

    // Confirmed speech in progress — wait for silence timeout
    if (this.silenceTimer) return;
    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.isSpeaking = false;
      this.callbacks.onSpeechEnd();
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    }, SILENCE_TIMEOUT_MS);
  }

  // --- Recording ---

  private startRecording(): void {
    if (!this.stream) return;
    this.chunks = [];
    this.mediaRecorder = new MediaRecorder(this.stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm',
    });
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.onstop = () => {
      this.processRecording();
    };
    this.mediaRecorder.start(100);
  }

  private async processRecording(): Promise<void> {
    const duration = Date.now() - this.speechStartTime;

    // Unmute the AI now that we have the recording
    if (this.isMuted) {
      // Don't unmute yet — wait for transcript processing
      // The orchestrator will handle resumption
      this.isMuted = false;
    }

    if (duration < MIN_RECORDING_MS || this.chunks.length === 0) {
      return;
    }

    const blob = new Blob(this.chunks, { type: 'audio/webm' });
    this.chunks = [];

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
