/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

// https://vite.dev/config/
export default defineConfig({
  root: realpathSync(process.cwd()),
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: [fileURLToPath(new URL('./src/test/setup.ts', import.meta.url))],
    globals: true,
  },
})
