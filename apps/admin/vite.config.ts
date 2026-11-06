import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The dashboard is a same-origin client of the API: /v1 is proxied to the
// locally running api (:3000), so no CORS or credentials flow is needed in dev
// (ADR 0025). Production deploys sit behind one origin as well.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Bind 0.0.0.0 so a phone or a second laptop on the same network can reach
    // the dev server at this machine's LAN IP. Dev only; the API already listens
    // on 0.0.0.0 and the proxy target below stays loopback.
    host: true,
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
});
