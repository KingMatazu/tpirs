import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { VitePWA } from "vite-plugin-pwa";

// The collector app: the phone UI a collector uses in the street to take the
// daily levy in cash. Same origin as the API through the dev proxy, same
// generated client as the dashboard and the officer app.
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: "prompt",
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
        // Cash is never recorded offline (the intake needs the ledger), so no
        // API responses are cached: a stale balance is worse than a spinner.
        runtimeCaching: [],
      },
      manifest: {
        name: "TPIRS Collector",
        short_name: "Collector",
        start_url: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#0f172a",
        icons: [],
      },
    }),
  ],
  server: {
    port: 5175,
    proxy: {
      "/v1": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
