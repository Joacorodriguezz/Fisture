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
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute("content", "summary_large_image");
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", `${BASE}/og-image.png`);
});

test("imagen para compartir, íconos y manifest existen", async ({ page }) => {
  for (const ruta of ["/og-image.png", "/apple-touch-icon.png", "/favicon-32.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"]) {
    const res = await page.request.get(ruta);
    expect(res.status(), ruta).toBe(200);
    expect(res.headers()["content-type"], ruta).toContain("image/png");
  }
  const manifest = await (await page.request.get("/site.webmanifest")).json();
  expect(manifest).toMatchObject({ short_name: "FISTURE", start_url: "/hoy" });
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

test("ayuda: preguntas frecuentes con FAQPage y enlazada desde el pie", async ({ page }) => {
  await page.goto("/ligas");
  await page.getByRole("contentinfo").getByRole("link", { name: "Ayuda", exact: true }).click();
  await expect(page).toHaveURL(/\/ayuda$/);
  await expect(page.getByRole("heading", { name: "¿Qué permisos pide Fisture y por qué?" })).toBeVisible();
  const [faq] = await jsonLd(page);
  expect(faq["@type"]).toBe("FAQPage");
  expect(faq.mainEntity.length).toBeGreaterThan(5);
});

test("docs/29: un id inexistente da 404 con noindex, no una redirección (soft 404)", async ({ page, request }) => {
  for (const ruta of ["/ligas/no-existe", "/equipos/no-existe", "/partidos/no-existe", "/ruta-que-no-existe"]) {
    const res = await request.get(ruta, { maxRedirects: 0 });
    expect(res.status(), ruta).toBe(404);
  }
  const res = await page.goto("/partidos/ya-se-jugo");
  expect(res?.status()).toBe(404);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("FUERA DE JUEGO");
  await page.getByRole("main").getByRole("link", { name: "Próximos partidos" }).click();
  await expect(page).toHaveURL(`${BASE}/partidos`);
});

test("docs/29: /equipos redirige con 301 a /ligas", async ({ request }) => {
  const res = await request.get("/equipos", { maxRedirects: 0 });
  expect(res.status()).toBe(301);
  expect(res.headers()["location"]).toBe("/ligas");
});
