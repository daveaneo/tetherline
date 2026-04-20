import { useCallback, useRef, useEffect } from 'react';
import { useAudioStore } from '../state/audio-store.js';
import { useSettingsStore } from '../state/settings-store.js';
import type { NarrationSegment } from '@tetherline/shared';
import { API_PREFIX } from '@tetherline/shared';

export function useAudioPlayback() {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
  const { currentSegment, isPlaying, setCurrentSegment, setPlaying, dequeueSegment } = useAudioStore();
  const ttsProvider = useSettingsStore(s => s.settings.ttsProvider);

  // Play a segment using the configured TTS provider
  const playSegment = useCallback(async (segment: NarrationSegment) => {
    setCurrentSegment(segment);
    setPlaying(true);

    if (ttsProvider === 'openai') {
      // Fetch audio from backend TTS endpoint
      try {
        const res = await fetch(`${API_PREFIX}/audio/tts`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: segment.text }),
        });

        if (!res.ok) {
          // Fall back to browser TTS if OpenAI fails
          playBrowserTTS(segment.text);
          return;
        }

        const blob = await res.blob();
        const url = URL.createObjectURL(blob);

        if (!audioRef.current) {
          audioRef.current = new Audio();
        }

        audioRef.current.src = url;
        audioRef.current.onended = () => {
          URL.revokeObjectURL(url);
          onSegmentFinished();
        };
        audioRef.current.play();
      } catch {
        playBrowserTTS(segment.text);
      }
    } else {
      playBrowserTTS(segment.text);
    }
  }, [ttsProvider, setCurrentSegment, setPlaying]);

  const playBrowserTTS = useCallback((text: string) => {
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 0.95;
      utterance.pitch = 1.0;
      utterance.onend = () => onSegmentFinished();
      utteranceRef.current = utterance;
      speechSynthesis.speak(utterance);
    }
  }, []);

  const onSegmentFinished = useCallback(() => {
    setPlaying(false);
    const next = dequeueSegment();
    if (next) {
      playSegment(next);
    }
  }, [dequeueSegment, playSegment, setPlaying]);

  const pause = useCallback(() => {
    if (ttsProvider === 'openai' && audioRef.current) {
      audioRef.current.pause();
    } else if ('speechSynthesis' in window) {
      speechSynthesis.pause();
    }
    setPlaying(false);
  }, [ttsProvider, setPlaying]);

  const resume = useCallback(() => {
    if (ttsProvider === 'openai' && audioRef.current) {
      audioRef.current.play();
    } else if ('speechSynthesis' in window) {
      speechSynthesis.resume();
    }
    setPlaying(true);
  }, [ttsProvider, setPlaying]);

  const stop = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    if ('speechSynthesis' in window) {
      speechSynthesis.cancel();
    }
    setPlaying(false);
    setCurrentSegment(null);
  }, [setPlaying, setCurrentSegment]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = '';
      }
      if ('speechSynthesis' in window) {
        speechSynthesis.cancel();
      }
    };
  }, []);

  return { playSegment, pause, resume, stop, isPlaying, currentSegment };
}
