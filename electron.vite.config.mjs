import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { fileURLToPath } from 'url'

const __dirname = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/index.js'),
      },
    },
  },
  preload: {
    build: {
      lib: {
        entry: resolve(__dirname, 'electron/preload.js'),
      },
    },
  },
  renderer: {
    root: resolve(__dirname, '.'),
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'index.html'),
      },
    },
    plugins: [react()],
  },
})
