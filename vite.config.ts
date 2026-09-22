import { defineConfig } from 'vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json' with { type: 'json' };

// Vanilla TS Chrome extension build. No framework plugins (React/Vue/etc.)
// are added here per project rules — see .cursorrules.
export default defineConfig({
  plugins: [crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
