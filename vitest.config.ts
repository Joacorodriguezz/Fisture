import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Los tests con D1 levantan Miniflare: darles margen
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
