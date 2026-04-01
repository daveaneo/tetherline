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

    // We need ALL chunks from the start (chunk 0 has the WebM header).
    // Slicing from the middle produces headerless data that can't be decoded.
    // Include everything — Whisper will handle the silence at the beginning.
    const allCurrentChunks = [...this.allChunks];
    if (allCurrentChunks.length === 0) return;

    // Reset buffer for next round
    this.allChunks = [];

    // Build a complete WebM blob (starts from chunk 0 which has the header)
    const mimeType = allCurrentChunks[0]?.type ?? 'audio/webm';
    const blob = new Blob(allCurrentChunks, { type: mimeType });

    // Send WebM directly to Whisper — no client-side conversion needed.
    // faster-whisper accepts WebM/Opus natively.
    try {
      const response = await fetch(`${API_PREFIX}/audio/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': mimeType },
        body: blob,
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

    // Restart the recorder to get a fresh WebM header for the next utterance
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.stop();
    }
    this.startContinuousRecording();
  }
}

