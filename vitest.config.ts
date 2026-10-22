import { defineConfig } from "vitest/config";

// El proyecto integration recoge automáticamente cualquier nuevo test que no sea unitario.
// Compartir exactamente la misma selección evita omisiones y doble ejecución.
const unitFiles = ["tests/unit/**/*.test.ts", "tests/observability/{logger,with-api}.test.ts"];

export default defineConfig({
  test: {
    testTimeout: 20_000,
    hookTimeout: 20_000,
    maxWorkers: 2,
    allowOnly: !process.env.CI,
    // Oculta los logs (console.*) de los tests que pasan; los que fallan los muestran completos.
    // Un test no debe depender de leer la consola: para eso se espía y se afirma (vi.spyOn).
    silent: "passed-only",
    reporters: process.env.CI ? ["default", "junit"] : ["default"],
    outputFile: { junit: "test-results/vitest.xml" },
    restoreMocks: true,
    unstubGlobals: true,
    projects: [
      { extends: true, test: { name: "unit", environment: "node", include: unitFiles } },
      { extends: true, test: { name: "integration", environment: "node", include: ["tests/**/*.test.ts"], exclude: [...unitFiles, "tests/e2e/**"] } },
    ],
    // Cobertura de un conjunto explícito de módulos críticos, no de toda la app (ver docs/13).
    // Al agregar o testear un módulo crítico nuevo, sumarlo a `include`.
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov", "json-summary"],
      include: [
        "src/lib/format.ts", "src/lib/auth/{guards,session,tokens}.ts", "src/lib/sync-ui.ts",
        "src/lib/calendar/*.ts",
        "src/lib/db/{preferences,queries}.ts", "src/lib/data-providers/{espn,sync}.ts",
        "src/lib/observability/*.ts",
        "src/pages/api/preferencias.ts", "src/pages/api/equipos/*.ts", "src/pages/api/calendario/*.ts",
      ],
      thresholds: {
        lines: 90, statements: 90, functions: 90, branches: 85,
        "src/lib/calendar/**": { lines: 95, statements: 95, functions: 95, branches: 90 },
      },
    },
  },
});
