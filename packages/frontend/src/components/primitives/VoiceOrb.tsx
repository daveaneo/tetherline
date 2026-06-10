import type { VoiceState } from '../../state/audio-store.js';

type OrbState = VoiceState | 'thinking' | 'idle';

interface VoiceOrbProps {
  state?: OrbState;
  size?: number;
}

export function VoiceOrb({ state = 'listening', size = 140 }: VoiceOrbProps) {
  return (
    <div
      className={`orb is-${state}`}
      style={{ ['--orb-size' as string]: `${size}px` }}
      data-testid="voice-orb"
      data-state={state}
      aria-hidden="true"
    >
      <div className="orb-halo" />
      <div className="orb-core" />
      <div className="orb-ring" />
    </div>
  );
}
