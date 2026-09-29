import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // Consumed as TypeScript source rather than a build artefact, so the
      // protocol types can never drift from the server's.
      '@webmux/shared': path.resolve(import.meta.dirname, '../shared/src/index.ts'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:8866', changeOrigin: true },
      // ws:true is required or the terminal upgrade is answered by the SPA
      // fallback and the handshake fails with an opaque 200.
      '/ws': { target: 'ws://127.0.0.1:8866', ws: true },
      // Public share links are served by the backend, not the SPA. Without this
      // Vite answers `/s/<token>` itself and the feature is untestable in dev —
      // which is exactly the kind of gap that surfaces as "the link doesn't
      // work" after a deploy.
      '/s': { target: 'http://127.0.0.1:8866', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
