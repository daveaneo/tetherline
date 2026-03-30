import { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useSessionStore } from '../../state/session-store.js';
import { sendEvent } from '../../lib/ws-client.js';

export function QuestionPanel() {
  const state = useSessionStore(s => s.state);
  const qaAnswer = useSessionStore(s => s.qaAnswer);
  const qaAnswerDone = useSessionStore(s => s.qaAnswerDone);
  const [question, setQuestion] = useState('');
  const [answering, setAnswering] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const isOpen = state.phase === 'QA';

  // Reset state when the panel opens
  useEffect(() => {
    if (isOpen) {
      setQuestion('');
      setAnswering(false);
      inputRef.current?.focus();
    }
  }, [isOpen]);

  // Track when the answer is complete
  useEffect(() => {
    if (qaAnswerDone) {
      setAnswering(false);
    }
  }, [qaAnswerDone]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;

    sendEvent({ type: 'command:ask', payload: { question: question.trim() } });
    setAnswering(true);
  };

  const handleDismiss = () => {
    sendEvent({ type: 'command:next' }); // Returns to previous state
    setQuestion('');
    setAnswering(false);
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 backdrop-blur-sm"
        >
          <motion.div
            initial={{ scale: 0.9, y: 20 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.9, y: 20 }}
            className="w-full max-w-2xl mx-4 bg-[var(--color-surface)] border border-[var(--color-border)] rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
              <h3 className="font-semibold">Ask a Question</h3>
              <button onClick={handleDismiss} className="text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
                <kbd className="text-xs">Esc</kbd>
              </button>
            </div>

            <div className="p-6">
              <form onSubmit={handleSubmit} className="flex gap-3">
                <input
                  ref={inputRef}
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  placeholder="Ask anything about the code..."
                  className="flex-1 px-4 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm focus:outline-none focus:border-[var(--color-accent)]"
                  disabled={answering}
                />
                <button
                  type="submit"
                  disabled={!question.trim() || answering}
                  className="px-6 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-lg text-sm disabled:opacity-50 transition-colors"
                >
                  Ask
                </button>
              </form>

              {qaAnswer && (
                <div className="mt-4 p-4 bg-[var(--color-bg)] rounded-lg">
                  <p className="text-sm text-[var(--color-text)] leading-relaxed whitespace-pre-wrap">{qaAnswer}</p>
                </div>
              )}

              {answering && !qaAnswer && (
                <div className="mt-4 flex items-center gap-2 text-[var(--color-text-muted)]">
                  <div className="animate-spin w-4 h-4 border-2 border-[var(--color-accent)] border-t-transparent rounded-full" />
                  <span className="text-sm">Thinking...</span>
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
