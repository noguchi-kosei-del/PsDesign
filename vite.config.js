import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
    // host: true で全インターフェース (0.0.0.0 + ::) に listen し、Windows の
    // localhost 解決が IPv4 か IPv6 のどちらに振れても確実に繋がるようにする。
    // ※TAURI_DEV_HOST が指定されている場合はそちらを優先（LAN 越し開発時用）。
    host: host || true,
    hmr: host
      ? { protocol: "ws", host, port: 1431 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "chrome105",
    minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
