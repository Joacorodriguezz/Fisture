import { test, expect } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  // Solo se permiten requests a la app local (fuentes externas se omiten)
  await context.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});

test("las páginas salen con CSP y headers de seguridad", async ({ page }) => {
  const response = await page.goto("/hoy");
  const headers = response!.headers();
  expect(headers["content-security-policy"]).toMatch(/script-src 'self'( 'sha256-[^']+')+;/);
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["permissions-policy"]).toContain("camera=()");
});

test("la CSP no bloquea nada de la app (scripts inline, islands)", async ({ page }) => {
  const violaciones: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy/i.test(msg.text())) violaciones.push(msg.text());
  });
  for (const path of ["/", "/hoy", "/ligas", "/equipos/buscar", "/partidos", "/calendario", "/login"]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
  }
  // La island de búsqueda hidrata (client:visible) con la CSP activa
  const search = page.getByRole("searchbox", { name: "Buscar equipos" });
  await page.goto("/equipos/buscar");
  await search.scrollIntoViewIfNeeded();
  await expect(page.locator("astro-island[ssr]").filter({ has: search })).toHaveCount(0);
  expect(violaciones).toEqual([]);
});
