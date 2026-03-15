import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  server: {
    proxy: {
      '/api': {
        target: process.env.VITE_BACKEND_URL || 'http://localhost:5001',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: 'auto',
      manifest: {
        name: 'CipherChat Secure Relay',
        short_name: 'CipherChat',
        description: 'E2EE Secure Messaging App',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        icons: [
          {
            src: 'images/Drugs Images/blue_pill.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'images/Drugs Images/blue_pill.png',
            sizes: '512x512',
            type: 'image/png'
          }
        ]
      }
    })
  ],
})
