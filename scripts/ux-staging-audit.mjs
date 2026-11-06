// Auditoría pública de solo lectura. No inicia sesión ni envía formularios.
import { chromium, webkit, devices } from "playwright";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const origin = "https://development.fisture.pages.dev";
// Fuera de test-results: el runner E2E general limpia ese directorio al iniciar.
const output = resolve("ux-artifacts/staging");
await mkdir(output, { recursive: true });
const report = { generatedAt: new Date().toISOString(), origin, scope: "Páginas públicas, contextos nuevos, sin login ni escrituras", screens: [], errors: [] };
for (const [name, engine, settings] of [
  ["desktop", chromium, { viewport: { width: 1280, height: 900 } }],
  ["android", chromium, devices["Pixel 7"]],
  ["webkit", webkit, devices["iPhone 13"]],
]) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ ...settings, locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires" });
    // Bloquear cualquier escritura, incluso si la página la intentara al cargar.
    await context.route("**/*", (route) => route.request().method() === "GET" ? route.continue() : route.abort());
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const paths = ["/", "/login", "/hoy", "/ligas", "/equipos/buscar", "/calendario", "/ayuda"];
    const discovered = new Set();
    for (const path of paths) {
      try {
        const response = await page.goto(origin + path, { waitUntil: "load", timeout: 30_000 });
        await page.evaluate(() => document.fonts.ready);
        // Las rutas de detalle se obtienen del DOM, no se inventan identificadores.
        const links = await page.locator("main a[href]").evaluateAll((anchors) => anchors.map((anchor) => anchor.getAttribute("href")));
        for (const prefix of ["/ligas/", "/equipos/", "/partidos/"]) {
          const link = links.find((href) => href?.startsWith(prefix) && !href.startsWith("/equipos/buscar"));
          if (link && !discovered.has(prefix)) { discovered.add(prefix); paths.push(link); }
        }
        for (const theme of ["papel", "nocturna"]) {
          await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
          const filename = `${name}-${path.replaceAll(/[^a-zA-Z0-9-]/g, "_") || "home"}-${theme}.png`;
          const layout = await page.evaluate(() => ({
            title: document.title,
            heading: document.querySelector("h1")?.textContent,
            viewport: document.documentElement.clientWidth,
            content: document.documentElement.scrollWidth,
            height: document.documentElement.scrollHeight,
            text: document.querySelector("main")?.innerText,
            fonts: [...document.fonts].map((font) => ({ family: font.family, status: font.status })),
          }));
          const fullPage = layout.height < 8_000;
          await page.screenshot({ path: resolve(output, filename), fullPage, scale: "css" });
          const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
          report.screens.push({ device: name, path, theme, status: response?.status(), screenshot: filename, screenshotScope: fullPage ? "fullPage" : "viewport (página supera 8000px)", ...layout, violations: axe.violations, incomplete: axe.incomplete });
          console.log(`${name} ${path} ${theme}: HTTP ${response?.status()}, ${axe.violations.length} reglas con problemas, ancho ${layout.content}/${layout.viewport}`);
        }
      } catch (error) {
        report.errors.push({ device: name, path, error: String(error) });
        console.error(`${name} ${path}: ${error}`);
      }
      await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
    }
    await context.close();
  } finally { await browser.close(); }
}

// Comprobaciones exploratorias reproducibles en una pantalla pequeña, sin sesión.
const probeBrowser = await chromium.launch();
try {
  const context = await probeBrowser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true, locale: "es-AR" });
  await context.route("**/*", (route) => route.request().method() === "GET" ? route.continue() : route.abort());
  const page = await context.newPage();
  await page.goto(origin + "/equipos/buscar");
  await page.evaluate(() => document.fonts.ready);
  const search = page.getByRole("searchbox");
  const geometry = await search.boundingBox();
  await page.screenshot({ path: resolve(output, "busqueda-375x667.png"), scale: "css" });
  await search.fill("River");
  const beforeReload = await search.inputValue();
  await page.reload();
  const afterReload = await page.getByRole("searchbox").inputValue();
  await page.goto(origin + "/hoy");
  await page.evaluate(() => document.fonts.ready);
  const todayControls = await page.locator(".hm-partido button").evaluateAll((elements) => elements.slice(0, 3).map((element) => ({
    text: element.textContent,
    width: element.getBoundingClientRect().width,
    height: element.getBoundingClientRect().height,
  })));
  await page.screenshot({ path: resolve(output, "hoy-375x667.png"), scale: "css" });
  report.probe = { viewport: { width: 375, height: 667 }, search: { geometry, beforeReload, afterReload }, todayControls };
} catch (error) {
  report.errors.push({ device: "375x667", path: "probe", error: String(error) });
} finally { await probeBrowser.close(); }
await writeFile(resolve(output, "report.json"), JSON.stringify(report, null, 2));
console.log(`Reporte: ${resolve(output, "report.json")}`);
console.log("La recolección de evidencia no es una aprobación de release: revisar violations, incomplete y las pruebas manuales pendientes.");
if (report.errors.length) process.exitCode = 1;
