/**
 * Audio capture with echo cancellation + voice activity detection.
 * Replaces Web Speech API for speech-to-text.
 *
 * Flow:
 * 1. getUserMedia with echoCancellation → raw mic stream (speaker audio subtracted)
 * 2. AnalyserNode monitors volume → detects speech start/end
 * 3. MediaRecorder captures audio during speech
 * 4. On speech end, sends WAV to /api/audio/transcribe (local Whisper)
 */
import { API_PREFIX } from '@interactive-reviewer/shared';

export interface AudioCaptureCallbacks {
  onSpeechStart: () => void;
  onSpeechEnd: () => void;
  onTranscript: (text: string) => void;
  onError: (error: string) => void;
  onStateChange: (state: string) => void;
}

// Voice activity detection thresholds
const VAD_SPEECH_THRESHOLD = 15;   // RMS level to consider as speech
const VAD_SILENCE_THRESHOLD = 8;   // RMS level to consider as silence
const VAD_SPEECH_MIN_MS = 300;     // Min speech duration to record
const VAD_SILENCE_TIMEOUT_MS = 1200; // Silence duration to end recording

export class AudioCapture {
  private stream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private isCapturing = false;
  private isSpeaking = false;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private speechStartTime = 0;
  private vadInterval: ReturnType<typeof setInterval> | null = null;
  private callbacks: AudioCaptureCallbacks;

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
      this.callbacks.onStateChange('capture_started');
    } catch (err: any) {
      this.callbacks.onError(`Mic access failed: ${err.message}`);
    }
  }

  stop(): void {
    this.isCapturing = false;
    if (this.vadInterval) {
      clearInterval(this.vadInterval);
      this.vadInterval = null;
    }
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }

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

      if (!this.isSpeaking && rms > VAD_SPEECH_THRESHOLD) {
        this.onSpeechDetected();
      } else if (this.isSpeaking && rms < VAD_SILENCE_THRESHOLD) {
        this.onSilenceDetected();
      } else if (this.isSpeaking && rms >= VAD_SILENCE_THRESHOLD) {
        // Still speaking — reset silence timer
        if (this.silenceTimer) {
          clearTimeout(this.silenceTimer);
          this.silenceTimer = null;
        }
      }
    }, 50); // Check every 50ms
  }

  private onSpeechDetected(): void {
    this.isSpeaking = true;
    this.speechStartTime = Date.now();
    this.callbacks.onSpeechStart();

    // Start recording
    if (this.stream) {
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
      this.mediaRecorder.start(100); // Collect in 100ms chunks
    }
  }

  private onSilenceDetected(): void {
    if (this.silenceTimer) return; // Already waiting

    this.silenceTimer = setTimeout(() => {
      this.silenceTimer = null;
      this.isSpeaking = false;
      this.callbacks.onSpeechEnd();

      // Stop recording
      if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
        this.mediaRecorder.stop();
      }
    }, VAD_SILENCE_TIMEOUT_MS);
  }

  private async processRecording(): Promise<void> {
    const duration = Date.now() - this.speechStartTime;

    // Ignore very short bursts (likely noise)
    if (duration < VAD_SPEECH_MIN_MS || this.chunks.length === 0) {
      return;
    }

    const blob = new Blob(this.chunks, { type: 'audio/webm' });
    this.chunks = [];

    // Convert to WAV and send to Whisper
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
    // Decode webm to raw audio using AudioContext, then encode as WAV
    const arrayBuffer = await webmBlob.arrayBuffer();
    const audioCtx = new AudioContext({ sampleRate: 16000 });

    try {
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
      const channelData = audioBuffer.getChannelData(0);

      // Encode as 16-bit PCM WAV
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

  // WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);          // chunk size
  view.setUint16(20, 1, true);           // PCM format
  view.setUint16(22, 1, true);           // mono
  view.setUint32(24, sampleRate, true);   // sample rate
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true);           // block align
  view.setUint16(34, 16, true);          // bits per sample
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);

  // PCM data
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
