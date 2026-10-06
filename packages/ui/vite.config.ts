import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// A UI corre em http://localhost:5173 (o backend/pipeline, na Fase 5,
// passa a servir tudo em http://localhost:3000 conforme ARCHITECTURE.md).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
  },
});
