import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vitejs.dev/config/
// Tauri sets TAURI_ENV_DEBUG for `tauri dev` and `tauri build --debug`. The
// flag is replaced at build time, so the checks it guards are dropped from the
// release bundle rather than merely skipped.
const debugBuild = process.env.TAURI_ENV_DEBUG === "true";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __PREEN_DEBUG__: JSON.stringify(debugBuild) },
  // Vite options tailored for Tauri: keep Rust errors visible, fixed port,
  // don't watch the Rust side.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
