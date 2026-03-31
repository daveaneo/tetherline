import { useAudioStore } from '../../state/audio-store.js';
import { useSessionStore } from '../../state/session-store.js';
import { motion, AnimatePresence } from 'framer-motion';
import { AudioVisualizer } from '../audio/AudioVisualizer.js';
import { VoiceInput } from '../audio/VoiceInput.js';
import { sendEvent } from '../../lib/ws-client.js';

export function NarrationBar() {
  const { currentSegment, isPlaying } = useAudioStore();
  const state = useSessionStore(s => s.state);

  return (
    <div className="h-20 border-t border-[var(--color-border)] bg-[var(--color-surface)] flex items-center px-6 gap-4">
      {/* Playback controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => sendEvent(state.paused ? { type: 'command:resume' } : { type: 'command:pause' })}
          className="w-10 h-10 flex items-center justify-center rounded-full border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors"
          title={state.paused ? 'Resume' : 'Pause'}
        >
          {state.paused ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><polygon points="5,3 19,12 5,21" /></svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
          )}
        </button>
        {isPlaying && <AudioVisualizer />}
      </div>

      {/* Narration text */}
      <div className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          {currentSegment ? (
            <motion.p
              key={currentSegment.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              transition={{ duration: 0.2 }}
              className="text-sm text-[var(--color-text)] leading-relaxed line-clamp-2"
            >
              {currentSegment.text}
            </motion.p>
          ) : (
            <motion.p
              key="idle"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="text-sm text-[var(--color-text-muted)] italic"
            >
              {state.phase === 'ANALYZING' ? 'Analyzing repository...' : 'Listening...'}
            </motion.p>
          )}
        </AnimatePresence>
      </div>

      {/* Navigation shortcuts */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => sendEvent({ type: 'command:previous' })}
          className="px-3 py-1.5 text-xs rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors"
          title="Previous"
        >
          &larr; Back
        </button>
        <button
          onClick={() => sendEvent({ type: 'command:skip' })}
          className="px-3 py-1.5 text-xs rounded-md border border-[var(--color-border)] hover:bg-[var(--color-surface-hover)] transition-colors"
          title="Skip"
        >
          Skip &rarr;
        </button>
      </div>

      {/* Voice input */}
      <VoiceInput />
    </div>
  );
}
