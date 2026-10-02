import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    sourcemap: false,
    rollupOptions: {
      input: resolve(projectRoot, "transcript.html"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/transcript-api": {
        target: "http://127.0.0.1:3011",
        changeOrigin: false,
        rewrite: (path) => path.replace(/^\/transcript-api/, ""),
      },
    },
  },
});
