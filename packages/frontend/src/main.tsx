import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { SceneHost, isSceneMode } from './scenes/SceneHost.js';
import { startDebugRecorder } from './lib/debug-recorder.js';
import './styles/global.css';

// DEV scene harness: `?scene=<name>` boots a deterministic, backend-
// less render of a specific UI state. Never active in production
// (isSceneMode is gated on import.meta.env.DEV).
const Root = isSceneMode() ? SceneHost : App;

// DEV debug recorder — telemeters every screen transition (state +
// DOM-text + visual) to /api/dev/telemetry → /tmp/tetherline-debug.jsonl
// so Claude can review the lived experience in detail afterwards.
// Skipped in scene mode (deterministic harness has no session flow).
if (!isSceneMode()) startDebugRecorder();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
