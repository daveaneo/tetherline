/** SceneHost (H1) — DEV-only deterministic renderer.
 *
 * Renders the REAL AppShell + Room with stores pre-seeded from a
 * scene fixture, and WITHOUT useWebSocket/orchestrator/voice hooks —
 * so a scene needs no backend and can never hang on a WS. Seeds
 * synchronously before first paint via a useState initializer.
 */
import { useState } from 'react';
import { AppShell } from '../components/layout/AppShell.js';
import { Room } from '../components/room/Room.js';
import { SettingsPanel } from '../components/settings/SettingsPanel.js';
import { SCENES, getScene } from './registry.js';

function sceneParam(): string | null {
  return new URLSearchParams(window.location.search).get('scene');
}

/** True when the app should boot into scene mode (DEV + ?scene=). */
export function isSceneMode(): boolean {
  return !!import.meta.env.DEV && sceneParam() !== null;
}

function SceneIndex() {
  return (
    <div style={{ padding: 40, fontFamily: 'var(--mono, monospace)', color: 'var(--cream-200, #e8dcc8)' }}>
      <h1 style={{ fontSize: 16, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--amber-400, oklch(0.74 0.12 65))', marginBottom: 20 }}>
        Scene harness · {SCENES.length} scenes
      </h1>
      <ul style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {SCENES.map(s => (
          <li key={s.name}>
            <a href={`?scene=${s.name}`} style={{ color: 'var(--amber-400, oklch(0.74 0.12 65))' }}>
              {s.name}
            </a>
            <span style={{ color: 'var(--cream-500, #8a7d68)', marginLeft: 12, fontSize: 12 }}>
              {s.description}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function SceneHost() {
  const name = sceneParam();
  // Seed exactly once, synchronously, before children render.
  useState(() => {
    if (name && name !== 'index') getScene(name)?.seed();
    return true;
  });

  if (!name || name === 'index') {
    return (
      <AppShell>
        <SceneIndex />
      </AppShell>
    );
  }
  if (!getScene(name)) {
    return (
      <AppShell>
        <div style={{ padding: 40, color: 'var(--cream-500, #8a7d68)', fontFamily: 'var(--mono, monospace)' }}>
          Unknown scene "{name}". <a href="?scene=index" style={{ color: 'var(--amber-400, oklch(0.74 0.12 65))' }}>See all scenes</a>.
        </div>
      </AppShell>
    );
  }
  return (
    <AppShell>
      <main className="flex-1 overflow-hidden">
        <Room />
      </main>
      <SettingsPanel />
    </AppShell>
  );
}
