import { motion, AnimatePresence } from 'framer-motion';
import { useSessionStore } from '../../state/session-store.js';

/** Shown in the session Room when a narration:briefing event arrives.
 *  Pre-rendered opener text + children suggestions ("you can go deeper into …"). */
export function BriefingCard() {
  const briefing = useSessionStore(s => s.currentBriefing);

  return (
    <AnimatePresence mode="wait">
      {briefing && (
        <motion.div
          key={briefing.briefingId + String(briefing.receivedAt)}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
          className="panel"
          style={{
            padding: 28,
            maxWidth: 720,
            margin: '0 auto',
            background:
              'radial-gradient(ellipse at top right, color-mix(in oklch, var(--amber-500) 10%, transparent), transparent 60%), var(--ink-100)',
          }}
        >
          <div className="kicker" style={{ color: 'var(--amber-400)' }}>
            {briefing.layer === 'project' ? 'Project briefing' :
             briefing.layer === 'architecture' ? 'Architecture' :
             briefing.layer === 'module' ? 'Module' :
             briefing.layer === 'concept' ? 'Concept' :
             briefing.layer === 'file' ? 'File' : 'Briefing'}
          </div>
          <h2
            className="font-serif mt-2"
            style={{ fontSize: 36, fontWeight: 300, letterSpacing: '-0.018em', color: 'var(--cream-900)', lineHeight: 1.1 }}
          >
            {briefing.title}
          </h2>
          {briefing.resumePrefix && (
            <p className="font-mono mt-3" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--amber-400)' }}>
              {briefing.resumePrefix}
            </p>
          )}
          <p className="narration mt-4" style={{ fontSize: 20, maxWidth: '58ch' }}>
            {briefing.text}
          </p>

          {briefing.talkingPoints.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-2">
              {briefing.talkingPoints.slice(0, 5).map(p => (
                <span
                  key={p}
                  className="font-mono"
                  style={{
                    fontSize: 11,
                    padding: '4px 10px',
                    borderRadius: 'var(--r-pill)',
                    background: 'oklch(1 0 0 / 0.04)',
                    border: '1px solid oklch(1 0 0 / 0.06)',
                    color: 'var(--cream-600)',
                    letterSpacing: '0.02em',
                  }}
                >
                  {p}
                </span>
              ))}
            </div>
          )}

          {briefing.children.length > 0 && (
            <div className="mt-5">
              <div className="kicker mb-2">You can drill into</div>
              <div className="flex flex-wrap gap-2">
                {briefing.children.slice(0, 6).map(c => (
                  <span
                    key={c}
                    style={{
                      fontSize: 12,
                      padding: '6px 12px',
                      borderRadius: 'var(--r-md)',
                      background: 'oklch(1 0 0 / 0.03)',
                      border: '1px solid oklch(1 0 0 / 0.05)',
                      color: 'var(--cream-600)',
                      fontFamily: 'var(--serif)',
                      fontStyle: 'italic',
                    }}
                  >
                    {prettyChildLabel(c)}
                  </span>
                ))}
              </div>
              <div className="font-mono mt-2" style={{ fontSize: 10.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--cream-500)' }}>
                Say &ldquo;tell me about &hellip;&rdquo; or &ldquo;deeper&rdquo; to continue.
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function prettyChildLabel(id: string): string {
  if (id.startsWith('module/')) return id.slice('module/'.length);
  if (id.startsWith('concept/')) return id.slice('concept/'.length);
  if (id.startsWith('file/')) return id.slice('file/'.length);
  if (id === 'arch/root') return 'architecture';
  return id;
}
