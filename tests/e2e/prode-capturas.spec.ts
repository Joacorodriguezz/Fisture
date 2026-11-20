// Capturas de evidencia del prode (docs/37 §2.5) en docs/ux-evidence/prode/. No corre en la suite:
// PRODE_CAPTURAS=1 npx playwright test tests/e2e/prode-capturas.spec.ts --project=desktop
// Escala 1 (como el resto de docs/ux-evidence) para no inflar el repo.
import { test, expect, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SALIDA = join(process.cwd(), "docs", "ux-evidence", "prode");
const BASE = "http://127.0.0.1:4322";

test.skip(!process.env.PRODE_CAPTURAS, "Solo con PRODE_CAPTURAS=1");

const PANTALLAS: Record<string, BrowserContextOptions> = {
  escritorio: { viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 },
  movil: { viewport: { width: 375, height: 812 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true },
};

async function pagina(browser: Browser, opciones: BrowserContextOptions, sesion?: string): Promise<Page> {
  const ctx = await browser.newContext({ ...opciones, locale: "es-AR", timezoneId: "America/Argentina/Buenos_Aires" });
  await ctx.route(/https?:\/\//, (r) => {
    const host = new URL(r.request().url()).hostname;
    return ["127.0.0.1", "fonts.googleapis.com", "fonts.gstatic.com"].includes(host) ? r.continue() : r.abort();
  });
  if (sesion) await ctx.addCookies([{ name: "session", value: `e2e-${sesion}`, url: BASE, httpOnly: true }]);
  return ctx.newPage();
}

async function capturar(page: Page, nombre: string, pantalla: string, completa = pantalla === "escritorio") {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SALIDA, `${nombre}-${pantalla}.png`), fullPage: completa });
}

for (const [pantalla, opciones] of Object.entries(PANTALLAS)) {
  test(`capturas del prode (${pantalla})`, async ({ browser }) => {
    test.setTimeout(120_000);
    mkdirSync(SALIDA, { recursive: true });

    let page = await pagina(browser, opciones);
    await page.goto(`${BASE}/prode`);
    await capturar(page, "presentacion", pantalla, true);
    await page.goto(`${BASE}/prode/unirse/SUMATE23`);
    await capturar(page, "invitacion", pantalla);
    await page.goto(`${BASE}/prode/unirse/ZZZZZZZZ`);
    await capturar(page, "codigo-inexistente", pantalla);

    page = await pagina(browser, opciones, "desktop-prode-crear-0");
    await page.goto(`${BASE}/prode`);
    await capturar(page, "sin-grupos", pantalla, true);

    page = await pagina(browser, opciones, `desktop-prode-jugar-${pantalla === "movil" ? 1 : 0}`);
    await page.goto(`${BASE}/prode/grupo-e2e`);
    const racing = page.getByRole("textbox", { name: "Goles de Racing Club" });
    await expect(page.locator("astro-island[ssr]")).toHaveCount(0);
    await page.getByRole("button", { name: "Sumar un gol a Estudiantes" }).click();
    await page.getByRole("button", { name: "Guardar pronósticos" }).click();
    await expect(page.getByText("Guardamos 1 pronóstico.")).toBeVisible();
    await racing.fill("2");
    await page.getByRole("button", { name: "Sumar un gol a Independiente" }).click();
    await racing.scrollIntoViewIfNeeded();
    await capturar(page, "pronosticos-sin-guardar", pantalla, false);
    await page.getByRole("button", { name: "Guardar pronósticos" }).click();
    await expect(page.getByText("Guardamos 1 pronóstico.")).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 0));
    await capturar(page, "pronosticos", pantalla);

    await page.goto(`${BASE}/prode/grupo-e2e?tab=tabla`);
    await capturar(page, "tabla", pantalla, true);
    await page.evaluate(() => (document.documentElement.dataset.theme = "nocturna"));
    await capturar(page, "tabla-nocturna", pantalla);

    await page.goto(`${BASE}/prode/grupo-e2e?tab=historial`);
    await page.locator("details").first().evaluate((d) => ((d as HTMLDetailsElement).open = true));
    await capturar(page, "historial", pantalla, true);

    await page.goto(`${BASE}/prode`);
    await capturar(page, "mis-grupos", pantalla, true);

    page = await pagina(browser, opciones, `desktop-prode-admin-${pantalla === "movil" ? 1 : 0}`);
    await page.goto(`${BASE}/prode/admin-desktop-prode-admin-${pantalla === "movil" ? 1 : 0}?tab=grupo`);
    await capturar(page, "grupo-administrar", pantalla, true);
    await page.getByRole("button", { name: /^Sacar a / }).click();
    await page.getByRole("group", { name: "Confirmar la acción" }).scrollIntoViewIfNeeded();
    await capturar(page, "grupo-confirmar", pantalla, false);
  });
}
