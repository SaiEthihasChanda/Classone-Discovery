import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
  // All three services share the single .env at the repo root, so point Vite
  // one level up instead of keeping a second copy here.
  envDir: path.resolve(here, '..'),
  server: {
    port: 5173,
    strictPort: true,
    // Same as the deployed site (deploy/Caddyfile.template): /api on the app's own address reaches the
    // backend, so links built from APP_URL — campaign tracking, booking — also work in development.
    proxy: { '/api': process.env.VITE_PROXY_TARGET ?? 'http://localhost:4000' },
  },
});
