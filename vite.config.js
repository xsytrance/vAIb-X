import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // In production/Android builds, VITE_API_BASE points directly to the API server.
  // In dev, the Vite proxy handles /api/backend/* → localhost:5555.
  define: {
    __API_BASE__: JSON.stringify(process.env.VITE_API_BASE || ''),
  },
  server: {
    host: '0.0.0.0',
    port: 5556,
    proxy: {
      '/api/backend': {
        target: 'http://127.0.0.1:5555',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/backend/, ''),
      },
    },
  },
})
