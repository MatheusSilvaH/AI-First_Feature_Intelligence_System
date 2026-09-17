import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // The browser never talks to Anthropic. It talks to /api on this origin,
    // which Vite proxies to the Node backend that holds the API key.
    proxy: {
      "/api": {
        target: "http://localhost:4000",
        changeOrigin: true,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Recharts is ~400KB and only the dashboard route needs it. Splitting it
        // out keeps it off the critical path for submit/browse.
        manualChunks: {
          charts: ["recharts"],
        },
      },
    },
  },
});
