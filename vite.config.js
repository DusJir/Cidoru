import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Electron bundles a recent Chromium; the web demo build also no longer
    // needs old-browser support. esnext avoids esbuild down-transforming
    // modern syntax (e.g. rest+default destructuring) it no longer supports
    // for vite's old default target list.
    target: 'esnext',
  },
})