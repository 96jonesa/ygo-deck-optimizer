import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Sandboxed preload scripts must be CommonJS; "type": "module"
        // would otherwise make electron-vite emit ESM (.mjs), which
        // Electron silently fails to load into the sandbox. The window's
        // preload path ('../preload/index.cjs') is the other half of this.
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    plugins: [react()],
  },
});
