import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  },
  server: {
    port: 3003,
    proxy: {
      '/mcp': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        timeout: 180000
      },
      '/api/gptge': {
        target: 'https://api.gpt.ge',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gptge/, ''),
        timeout: 1800000,
        proxyTimeout: 1800000
      },
      '/api/apiplus': {
        target: '<API_BASE_URL>',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/apiplus/, ''),
        timeout: 1800000,
        proxyTimeout: 1800000
      },
      '/api/moonshot': {
        target: 'https://api.moonshot.cn',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/moonshot/, ''),
        timeout: 1800000,
        proxyTimeout: 1800000
      },
      '/api/deepseek': {
        target: 'https://api.deepseek.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/deepseek/, ''),
        timeout: 1800000,
        proxyTimeout: 1800000
      }
    }
  }
})
