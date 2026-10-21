import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 2,
    restoreMocks: true,
    unstubGlobals: true,
    projects: [
      { extends: true, test: { name: "unit", environment: "node", include: ["tests/unit/**/*.test.ts", "tests/observability/{logger,with-api}.test.ts"] } },
      { extends: true, test: { name: "integration", environment: "node", include: ["tests/integration/**/*.test.ts", "tests/smoke/**/*.test.ts", "tests/observability/{health,sync-runs,run-sync,consistency}.test.ts"] } },
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: [
        "src/lib/format.ts", "src/lib/auth/{session,tokens}.ts",
        "src/lib/calendar/{ics,google,microsoft,sync-service}.ts",
        "src/lib/db/{preferences,queries}.ts", "src/lib/data-providers/{espn,sync}.ts",
        "src/lib/observability/*.ts",
        "src/pages/api/preferencias.ts", "src/pages/api/equipos/*.ts", "src/pages/api/calendario/download.ts",
      ],
      thresholds: { lines: 75, statements: 75, functions: 75, branches: 65 },
    },
  },
});
