import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Tauri 移动端/局域网调试时会注入 TAURI_DEV_HOST
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [vue()],

  // 让 Tauri 能看到 Rust 侧的编译报错，别清屏
  clearScreen: false,

  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // src-tauri 由 cargo 自己监听，交给 vite 会疯狂触发重编译
      ignored: ['**/src-tauri/**'],
    },
  },

  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // Tauri 走的是 file:// 或自定义协议，不需要 sourcemap
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    target: 'esnext',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
  },
})
