import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// `npm run dev` serves the UI with hot reload and sends /oc and /hq to the HQ server (server.mjs).
export default defineConfig({
  plugins: [react()],
  server: { port: 4111, proxy: { "/oc": "http://127.0.0.1:4112", "/hq": "http://127.0.0.1:4112" } },
  build: {
    outDir: "dist",
    chunkSizeWarningLimit: 600,
    // Libraries in their own files: they rarely change, so after an HQ update a phone only downloads the app's own code.
    rollupOptions: {
      output: {
        manualChunks: (id) =>
          id.includes("node_modules/highlight.js") ? "highlight" :
          /node_modules\/(marked|dompurify)/.test(id) ? "markdown" :
          /node_modules\/(react|react-dom|scheduler)\//.test(id) ? "react" :
          id.includes("node_modules/lucide-react") ? "icons" : undefined,
      },
    },
  },
});
