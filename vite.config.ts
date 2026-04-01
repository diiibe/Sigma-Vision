import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ["three", "@react-three/fiber", "@react-three/drei"],
  },
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8000",
        changeOrigin: true,
      },
    },
  },
  build: {
    chunkSizeWarningLimit: 800,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/three")) {
            return "three-core";
          }

          if (id.includes("@react-three/drei")) {
            return "scene-drei";
          }

          if (id.includes("@react-three/fiber")) {
            return "scene-fiber";
          }

          if (id.includes("@react-spring/three")) {
            return "scene-spring";
          }

          return undefined;
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./vitest.setup.ts",
    css: true,
  },
});
