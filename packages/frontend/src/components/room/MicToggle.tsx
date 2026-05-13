/**
 * Mic on/off toggle in the chrome toolbar.
 *
 * Default: OFF. The user explicitly enables continuous listening when
 * they want to hold the conversation hands-free. Even when off, the
 * spacebar PTT path stays active — hold space to talk.
 *
 * Visual contract:
 *   • OFF:         dim grey dot + "Mic off" label.
 *   • ON:          bright green pulsing dot + "Mic on" label.
 *   • UNAVAILABLE: warning amber dot + "Mic unavailable" label, tooltip
 *                  + click both lead to the fix instructions. Lying
 *                  about state ("Mic off" when nothing is wired up)
 *                  made users think the mic was just disabled and
 *                  search for a non-existent toggle.
 */
import { useAudioStore } from '../../state/audio-store.js';

const UNAVAILABLE_TOOLTIP = [
  'No speech backend is reachable.',
  '',
  'Fix (pick one):',
  '  • Start the Whisper sidecar:',
  '      python3 packages/backend/src/tts/audio-server.py',
  '  • Or open the app in Chrome / Edge (Web Speech API)',
  '  • Or set an OPENAI_API_KEY in your env',
].join('\n');

export function MicToggle() {
  const isMicOn = useAudioStore(s => s.micListening);
  const voiceMode = useAudioStore(s => s.voiceMode);

  const unavailable = voiceMode === 'none';

  const onToggle = () => {
    const store = useAudioStore.getState();
    if (unavailable) {
      // Re-emit the actionable toasts so the user sees the fix
      // even if the toast row already cleared.
      store.addSpeechToast('Voice input unavailable — no STT backend');
      store.addSpeechToast('Run: python3 packages/backend/src/tts/audio-server.py');
      store.addSpeechToast('Or open the app in Chrome/Edge');
      return;
    }
    if (isMicOn) store.requestMicStop();
    else store.requestMicStart();
  };

  const dotColor = unavailable
    ? 'var(--sig-warn, oklch(0.78 0.13 75))'
    : isMicOn ? 'var(--sig-okay)' : 'var(--cream-500)';
  const textColor = unavailable
    ? 'var(--sig-warn, oklch(0.78 0.13 75))'
    : isMicOn ? 'var(--sig-okay)' : 'var(--cream-500)';
  const bg = unavailable
    ? 'color-mix(in oklch, oklch(0.78 0.13 75) 12%, transparent)'
    : isMicOn
      ? 'color-mix(in oklch, var(--sig-okay) 14%, transparent)'
      : 'transparent';
  const label = unavailable ? 'Mic unavailable' : isMicOn ? 'Mic on' : 'Mic off';
  const tooltip = unavailable
    ? UNAVAILABLE_TOOLTIP
    : isMicOn
      ? 'Mic is ON — click to turn off'
      : 'Mic is OFF — click to turn on (or hold space to talk)';

  return (
    <button
      type="button"
      onClick={onToggle}
      className="text-xs transition-colors"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: '4px 8px', borderRadius: 999,
        border: '1px solid oklch(1 0 0 / 0.08)',
        background: bg,
        color: textColor,
        cursor: 'pointer',
      }}
      title={tooltip}
      aria-label={
        unavailable
          ? 'Mic unavailable — click for fix instructions'
          : isMicOn ? 'Turn mic off' : 'Turn mic on'
      }
      data-testid="mic-toggle"
      data-mic-state={unavailable ? 'unavailable' : isMicOn ? 'on' : 'off'}
    >
      <span
        style={{
          width: 7, height: 7, borderRadius: '50%',
          background: dotColor,
          boxShadow: isMicOn && !unavailable ? '0 0 6px var(--sig-okay)' : 'none',
          opacity: unavailable ? 0.85 : isMicOn ? 1 : 0.5,
        }}
      />
      {label}
    </button>
  );
}
