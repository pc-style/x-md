import { resolve } from 'node:path'
import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'
import { apiDevPlugin } from './src/vite-api-plugin'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value
  }

  return {
    plugins: [tailwindcss(), apiDevPlugin()],
    define: {
      'import.meta.env.VERCEL_ENV': JSON.stringify(process.env.VERCEL_ENV ?? 'development'),
    },
    build: {
      emptyOutDir: false,
      rollupOptions: {
        input: {
          main: resolve(import.meta.dirname, 'index.html'),
          admin: resolve(import.meta.dirname, 'admin.html'),
        },
      },
    },
    server: {
      port: 5173,
    },
  }
})
