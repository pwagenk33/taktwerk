import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

// `--mode single` bundles everything into one self-contained index.html running on example data (shareable prototype).
export default defineConfig(({ mode }) => ({
  plugins: mode === "single" ? [react(), viteSingleFile()] : [react()],
  build: { outDir: mode === "single" ? "dist-single" : "dist" },
  server: { proxy: { "/api": "http://localhost:3000" } },
}));
