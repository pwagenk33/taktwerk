import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";

function gitHash() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return process.env.GIT_HASH ?? "dev";
  }
}

// `--mode single` bundles everything into one self-contained index.html running on example data (shareable prototype).
export default defineConfig(({ mode }) => ({
  plugins: mode === "single" ? [react(), viteSingleFile()] : [react()],
  build: { outDir: mode === "single" ? "dist-single" : "dist" },
  define: { __BUILD__: JSON.stringify({ version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version, hash: gitHash(), date: new Date().toISOString().slice(0, 10) }) },
  server: { proxy: { "/api": "http://localhost:3000" } },
}));
