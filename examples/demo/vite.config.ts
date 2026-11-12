import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Cross-origin isolation lets the CPU fallback use wasm threads; credentialless still loads the model from
    // Hugging Face
    headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "credentialless" },
    // Lets ?video= play a local file through /@fs/
    fs: { strict: false }
  },
  // Pre-bundling would move the package's files, and its worker is found relative to them
  optimizeDeps: { exclude: ["chesscam-recorder"] }
});
