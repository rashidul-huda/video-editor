import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, '')
      },
      '/download': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/download-clip': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
      '/download-zip': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  },
  build: {
    rollupOptions: {
      input: {
        main: '/index.html',
        videotrimmer: '/videotrimmer.html'
      }
    }
  }
})
