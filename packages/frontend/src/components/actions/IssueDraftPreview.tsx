import { useState } from 'react';
import { sendEvent } from '../../lib/ws-client.js';
import { motion } from 'framer-motion';

interface Props {
  title: string;
  body: string;
  labels: string[];
  onDismiss: () => void;
}

export function IssueDraftPreview({ title, body, labels, onDismiss }: Props) {
  const [editTitle, setEditTitle] = useState(title);
  const [editBody, setEditBody] = useState(body);
  const [creating, setCreating] = useState(false);

  const handleCreate = () => {
    setCreating(true);
    sendEvent({ type: 'action:confirm_issue', payload: { title: editTitle, body: editBody, labels } });
    // The result comes back via action:issue_created or action:issue_failed
    setTimeout(onDismiss, 3000);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="p-4 rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5 space-y-3"
    >
      <h3 className="text-sm font-semibold text-[var(--color-accent)]">Draft GitHub Issue</h3>
      <input
        value={editTitle}
        onChange={e => setEditTitle(e.target.value)}
        className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm"
      />
      <textarea
        value={editBody}
        onChange={e => setEditBody(e.target.value)}
        rows={6}
        className="w-full px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg text-sm font-mono resize-y"
      />
      {labels.length > 0 && (
        <div className="flex gap-1">
          {labels.map(l => <span key={l} className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--color-surface)] border border-[var(--color-border)]">{l}</span>)}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={handleCreate}
          disabled={creating}
          className="px-4 py-2 bg-[var(--color-accent)] hover:bg-[var(--color-accent-hover)] text-white rounded-lg text-sm disabled:opacity-50"
        >
          {creating ? 'Creating...' : 'Create Issue'}
        </button>
        <button onClick={onDismiss} className="px-4 py-2 text-sm text-[var(--color-text-muted)] hover:text-[var(--color-text)]">
          Cancel
        </button>
        <p className="text-[10px] text-[var(--color-text-muted)] self-center ml-auto">or say &quot;looks good&quot; / &quot;cancel&quot;</p>
      </div>
    </motion.div>
  );
}
