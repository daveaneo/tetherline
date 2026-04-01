import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'child_process';

function getBuildVersion(): string {
  try {
    const date = new Date().toISOString().split('T')[0].replace(/-/g, '.');
    const count = execSync('git rev-list --count HEAD', { encoding: 'utf-8' }).trim();
    const hash = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
    return `${date}.${count} (${hash})`;
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    '__BUILD_VERSION__': JSON.stringify(getBuildVersion()),
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3847',
      '/ws': {
        target: 'ws://localhost:3847',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
  },
});
