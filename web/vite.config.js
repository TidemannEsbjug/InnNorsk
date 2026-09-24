import { defineConfig } from "vite";
import { viteCommonjs } from "@originjs/vite-plugin-commonjs";

export default defineConfig({
  root: ".",
  publicDir: "public",
  plugins: [viteCommonjs()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    commonjsOptions: { include: [/src/, /node_modules/] },
  },
  define: {
    global: "globalThis",
  },
  optimizeDeps: {
    include: ["buffer", "jszip", "xlsx", "pdfjs-dist/legacy/build/pdf.js"],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8788",
    },
  },
});
