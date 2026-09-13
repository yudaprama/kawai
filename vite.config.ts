import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  root: "frontend",
  envDir: path.resolve(__dirname),
  // Vue esm-bundler feature flags — required by the deck preview's Vue island
  // (deck-preview runtime). No-op for the React app otherwise.
  define: {
    __VUE_OPTIONS_API__: true,
    __VUE_PROD_DEVTOOLS__: false,
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: false,
  },
  plugins: [react(), tailwindcss()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "frontend/src"),
    },
  },

  build: {
    outDir: path.resolve(__dirname, "dist"),
    emptyOutDir: true,
    rollupOptions: {
      external: [
        /^shiki(\/.*)?$/,
        /^mermaid(\/.*)?$/,
        /^katex(\/.*)?$/,
        /^rehype-katex(\/.*)?$/,
        /^marked(\/.*)?$/,
        /^unified(\/.*)?$/,
        /^remark-parse(\/.*)?$/,
        /^remark-rehype(\/.*)?$/,
        /^remark-gfm(\/.*)?$/,
        /^remark-math(\/.*)?$/,
        /^rehype-raw(\/.*)?$/,
        /^rehype-sanitize(\/.*)?$/,
      ],
    },
  },

  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "src/**"],
    },
  },
});
