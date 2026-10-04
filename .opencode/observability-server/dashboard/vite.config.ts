import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: false,
    // Network access is already restricted at the firewall level (UFW allows
    // only 10.0.0.226 on this port), so disable Vite's Host-header
    // rebinding check to allow access via the "pai" hostname / any LAN name.
    allowedHosts: true,
  }
})
