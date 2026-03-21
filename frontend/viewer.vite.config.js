import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    "process.env": JSON.stringify({ NODE_ENV: "production" }),
    process: JSON.stringify({ env: { NODE_ENV: "production" } }),
  },
  build: {
    outDir: path.resolve(__dirname, "../webrtc/static"),
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: path.resolve(__dirname, "src/viewer/main.jsx"),
      name: "NeatInsightViewer",
      formats: ["iife"],
      fileName: () => "viewer-react.js",
    },
  },
});
