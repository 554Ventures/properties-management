import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // The 554 Properties API (apps/api) — everything under /api is proxied.
      // HEARTH_API_PROXY points a second web instance at a different API
      // (e.g. scripts/dev-test-user.sh's fresh-account stack on :3101).
      '/api': {
        target: process.env.HEARTH_API_PROXY ?? 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
});
