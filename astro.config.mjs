import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import tailwind from "@astrojs/tailwind";

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    // Workers no puede ejecutar sharp; el proyecto no usa astro:assets (los escudos son <img> remotos)
    imageService: "passthrough",
    platformProxy: {
      enabled: true,
    },
  }),
  integrations: [
    react(),
    tailwind(),
  ],
  vite: {
    resolve: {
      // React 19 usa MessageChannel en react-dom/server.browser, que Workers no tiene:
      // en producción se usa la build "edge" (solo en el build, el dev server la rompe)
      alias: import.meta.env.PROD ? { "react-dom/server": "react-dom/server.edge" } : {},
    },
  },
});
