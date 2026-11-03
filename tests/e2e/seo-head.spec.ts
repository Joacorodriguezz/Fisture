import { test, expect, type Page } from "@playwright/test";

const BASE = "http://127.0.0.1:4322";

test.beforeEach(async ({ context }) => {
  // Solo se permiten requests a la app local (fuentes externas se omiten)
  await context.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});

test("canonical absoluta sin query ni barra final", async ({ page }) => {
  await page.goto("/hoy/?x=1");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${BASE}/hoy`);
  await expect(page.locator('meta[property="og:url"]')).toHaveAttribute("content", `${BASE}/hoy`);

  await page.goto("/");
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${BASE}/`);
});

test("meta description por defecto y Open Graph/Twitter", async ({ page }) => {
  await page.goto("/ligas");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /^Sincronizá los partidos/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Ligas - FISTURE");
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
  await expect(page.locator('meta[property="og:locale"]')).toHaveAttribute("content", "es_AR");
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary");
  await expect(page.locator('meta[property="og:image"]')).toHaveCount(0);
});

test("noindex solo en login (páginas personales o de acceso)", async ({ page }) => {
  await page.goto("/login");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");

  await page.goto("/hoy");
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
});

test("noindex en /configuracion con sesión", async ({ page }, info) => {
  await page.context().addCookies([{ name: "session", value: `e2e-${info.project.name}-preferences-${info.retry}`, url: BASE, httpOnly: true }]);
  await page.goto("/configuracion");
  await expect(page).toHaveURL(`${BASE}/configuracion`);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /^noindex/);
});

const jsonLd = async (page: Page) =>
  (await page.locator('script[type="application/ld+json"]').allTextContents()).map((t) => JSON.parse(t));

test("datos estructurados: sitio en la home, SportsEvent en el partido", async ({ page }) => {
  await page.goto("/");
  expect((await jsonLd(page))[0]["@graph"].map((n: { "@type": string }) => n["@type"])).toContain("WebSite");

  await page.goto("/partidos/superclasico");
  const [evento, migas] = await jsonLd(page);
  expect(evento["@type"]).toBe("SportsEvent");
  expect(evento.url).toBe(`${BASE}/partidos/superclasico`);
  expect(migas["@type"]).toBe("BreadcrumbList");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /vs .* por .*: [a-zéá]+ \d+ de /);
  expect(evento.performer).toHaveLength(2);
});

test("descripciones de hasta 160 caracteres, sin undefined ni null", async ({ page }) => {
  for (const ruta of ["/", "/partidos/superclasico", "/equipos/river", "/ligas/e2e-league", "/partidos/neutral-match"]) {
    await page.goto(ruta);
    const descripcion = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
    expect(descripcion.length, ruta).toBeGreaterThan(50);
    expect(descripcion.length, ruta).toBeLessThanOrEqual(160);
    expect(descripcion, ruta).not.toMatch(/undefined|null/);
  }
});

test("datos estructurados en liga y equipo, y sin JSON-LD en el resto", async ({ page }) => {
  await page.goto("/ligas/e2e-league");
  expect((await jsonLd(page))[0]["@type"]).toBe("SportsOrganization");

  await page.goto("/equipos/river");
  expect((await jsonLd(page))[0]["@type"]).toBe("SportsTeam");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /^Fixture de /);

  await page.goto("/ligas");
  expect(await jsonLd(page)).toEqual([]);
});

test("llms.txt y sitemap con páginas dinámicas", async ({ request }) => {
  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(await llms.text()).toMatch(/^# FISTURE\n/);

  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).toContain(`<loc>${BASE}/ligas/e2e-league</loc>`);
  expect(sitemap).toContain(`<loc>${BASE}/equipos/river</loc>`);
});
