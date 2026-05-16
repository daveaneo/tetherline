import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.js';
import { SceneHost, isSceneMode } from './scenes/SceneHost.js';
import './styles/global.css';

// DEV scene harness: `?scene=<name>` boots a deterministic, backend-
// less render of a specific UI state. Never active in production
// (isSceneMode is gated on import.meta.env.DEV).
const Root = isSceneMode() ? SceneHost : App;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
