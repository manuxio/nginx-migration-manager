import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { outDir: 'dist' },
  // For `npm run dev` outside Docker: proxy API calls to the Express server.
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
