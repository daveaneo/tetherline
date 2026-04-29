/**
 * Mic on/off toggle in the chrome toolbar.
 *
 * Default: OFF. The user explicitly enables continuous listening when
 * they want to hold the conversation hands-free. Even when off, the
 * spacebar PTT path stays active — hold space to talk.
 *
 * Visual contract:
 *   • OFF: dim grey dot + "Mic off" label. AI cannot be interrupted by
 *     ambient noise; only space-PTT can.
 *   • ON: bright green pulsing dot + "Mic on" label. Ambient utterances
 *     are transcribed and routed.
 */
import { useAudioStore } from '../../state/audio-store.js';

export function MicToggle() {
  const isMicOn = useAudioStore(s => s.micListening);
  const onToggle = () => {
    const store = useAudioStore.getState();
    if (isMicOn) store.requestMicStop();
    else store.requestMicStart();
  };

  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-xs transition-colors"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 8px', borderRadius: 999,
        border: '1px solid oklch(1 0 0 / 0.08)',
        background: isMicOn
          ? 'color-mix(in oklch, var(--sig-okay) 14%, transparent)'
          : 'transparent',
        color: isMicOn ? 'var(--sig-okay)' : 'var(--cream-500)',
        cursor: 'pointer',
      }}
      title={isMicOn ? 'Mic is ON — click to turn off' : 'Mic is OFF — click to turn on (or hold space to talk)'}
      aria-label={isMicOn ? 'Turn mic off' : 'Turn mic on'}
      data-testid="mic-toggle"
      data-mic-state={isMicOn ? 'on' : 'off'}
    >
      <span
        style={{
          width: 7, height: 7, borderRadius: '50%',
          background: isMicOn ? 'var(--sig-okay)' : 'var(--cream-500)',
          boxShadow: isMicOn ? '0 0 6px var(--sig-okay)' : 'none',
          opacity: isMicOn ? 1 : 0.5,
        }}
      />
      {isMicOn ? 'Mic on' : 'Mic off'}
    </button>
  );
}
