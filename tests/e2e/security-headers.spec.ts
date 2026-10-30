import { test, expect, type Page } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  // Solo se permiten requests a la app local (fuentes externas se omiten)
  await context.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});

// Hashes (como los calcula el navegador) de los scripts inline que quedaron en el DOM
async function hashesInline(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll("script:not([src])")].map(async (s) => {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.textContent ?? ""));
        return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
      })
    )
  );
}

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

test("la CSP no bloquea nada de la app (scripts inline, islands, con y sin sesión)", async ({ page }, info) => {
  const violaciones: string[] = [];
  page.on("console", (msg) => {
    if (/Content Security Policy|Permissions-Policy/i.test(msg.text())) violaciones.push(msg.text());
  });
  const visitar = async (path: string) => {
    const response = await page.goto(path);
    await page.waitForLoadState("networkidle");
    // Cada script inline de la página tiene que estar en la lista fija de la CSP
    const csp = response!.headers()["content-security-policy"];
    for (const hash of await hashesInline(page)) expect(csp, `${path}: script inline sin autorizar`).toContain(`'${hash}'`);
  };
  for (const path of ["/", "/hoy", "/ligas", "/equipos/buscar", "/partidos", "/calendario", "/login", "/no-existe"]) await visitar(path);
  // La island de búsqueda hidrata (client:visible) con la CSP activa
  const search = page.getByRole("searchbox", { name: "Buscar equipos" });
  await page.goto("/equipos/buscar");
  await search.scrollIntoViewIfNeeded();
  await expect(page.locator("astro-island[ssr]").filter({ has: search })).toHaveCount(0);

  // Con sesión (solo lectura): islands client:load y la página sin el script del tema
  await page.context().addCookies([{ name: "session", value: `e2e-${info.project.name}-navigation-${info.retry}`, url: "http://127.0.0.1:4322", httpOnly: true }]);
  for (const path of ["/calendario", "/configuracion", "/equipos/river", "/partidos/superclasico"]) await visitar(path);
  await expect(page.locator('astro-island[client="load"]')).not.toHaveCount(0);
  await expect(page.locator('astro-island[client="load"][ssr]')).toHaveCount(0);
  expect(violaciones).toEqual([]);
});
