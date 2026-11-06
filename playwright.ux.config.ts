import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.config";

// Solo el worker local descartable. No admite apuntar los tests destructivos a staging/producción.
export default defineConfig({
  ...base,
  testDir: "./tests/e2e/ux",
  testIgnore: [],
  timeout: 60_000,
  retries: 0,
  outputDir: "ux-artifacts/local",
  reporter: [["list"], ["html", { outputFolder: "ux-report", open: "never" }], ["json", { outputFile: "ux-artifacts/local-results.json" }]],
  use: {
    ...base.use,
    locale: "es-AR",
    timezoneId: "America/Argentina/Buenos_Aires",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
    { name: "webkit-mobile", use: { ...devices["iPhone 13"] } },
  ],
});
