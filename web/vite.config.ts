import { defineConfig, splitVendorChunkPlugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [react(), tailwindcss(), splitVendorChunkPlugin()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@src': path.resolve(__dirname, '../src'),
    },
  },
  server: {
    port: 3000,
    proxy: {
      '/web': 'http://localhost:3791',
      '/logs': 'http://localhost:3791',
      '/health': 'http://localhost:3791',
    },
  },
  build: {
    outDir: 'dist',
  },
});
