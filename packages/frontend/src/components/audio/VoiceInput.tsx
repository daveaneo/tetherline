import { useVoiceInput } from '../../hooks/useVoiceInput.js';
import { motion } from 'framer-motion';

export function VoiceInput() {
  const { listening, toggleListening, supported } = useVoiceInput();

  if (!supported) return null;

  return (
    <button
      onClick={toggleListening}
      className={`relative flex items-center gap-2 px-4 py-2 rounded-lg text-sm transition-colors ${
        listening
          ? 'bg-red-500/20 border border-red-500/50 text-red-400'
          : 'border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-muted)]'
      }`}
      title={listening ? 'Stop listening' : 'Start voice commands'}
    >
      {listening && (
        <motion.div
          className="absolute inset-0 rounded-lg border-2 border-red-500/30"
          animate={{ scale: [1, 1.1, 1] }}
          transition={{ duration: 1.5, repeat: Infinity }}
        />
      )}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
        <line x1="12" y1="19" x2="12" y2="23" />
        <line x1="8" y1="23" x2="16" y2="23" />
      </svg>
      {listening ? 'Listening...' : 'Voice'}
    </button>
  );
}
