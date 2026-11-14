import { test, expect, type Page } from "@playwright/test";
import { diaISO, horaConDia, horaPorPais, listaConY } from "../../src/lib/format";

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

test("meta description propia y Open Graph/Twitter", async ({ page }) => {
  await page.goto("/ligas");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /^Liga Profesional, Brasileirão/);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Ligas de fútbol: fixture de cada torneo - FISTURE");
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
  for (const ruta of ["/login", "/login?next=%2Fcalendario"]) {
    await page.goto(ruta);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  }
  const robots = await (await page.request.get("/robots.txt")).text();
  expect(robots).not.toContain("Disallow: /login");

  await page.goto("/hoy");
  await expect(page.locator('meta[name="robots"]')).toHaveCount(0);
});

test("fixture y explicación del calendario son útiles sin JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE });
  try {
    await context.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const page = await context.newPage();
    await page.goto("/ligas/e2e-league");
    const fixture = page.getByRole("region", { name: "Próximos partidos", exact: true });
    await expect(fixture.locator('a[href="/partidos/superclasico"]')).toBeVisible();
    await expect(fixture.locator('a[href="/partidos/neutral-match"]')).toHaveCount(0);
    await page.goto("/equipos/river");
    const proximo = page.getByRole("region", { name: "Próximo partido", exact: true });
    const enlaceProximo = await proximo.getByRole("link").first().getAttribute("href");
    expect(enlaceProximo).not.toContain("cancelled");
    await page.goto("/equipos/river?lado=visitante");
    await expect(proximo.getByRole("link").first()).toHaveAttribute("href", enlaceProximo!);
    await expect(proximo.locator("time")).toHaveAttribute("datetime", /T.*Z$/);
    await expect(proximo.getByRole("link").first()).toHaveAttribute("href", /^\/partidos\//);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${BASE}/equipos/river`);

    // docs/33: título y h1 con las dos formas de búsqueda, respuesta directa, resultados y calendario
    await page.goto("/equipos/river");
    await expect(page).toHaveTitle("Partidos y fixture de River Plate - FISTURE");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Fixture y partidos de River Plate");
    await expect(proximo).toContainText(
      /River Plate juega su próximo partido el [a-záé]+ \d+ de [a-z]+ a las \d{2}:\d{2} \(hora de Argentina\) contra Boca Juniors, de local, por Liga E2E, en el estadio Monumental\./
    );
    const resultados = page.getByRole("region", { name: "Últimos resultados", exact: true });
    const filas = resultados.getByRole("listitem");
    await expect(filas).toHaveCount(2);
    await expect(filas.nth(0).getByRole("link")).toHaveAttribute("href", "/partidos/superclasico-ida");
    await expect(filas.nth(0)).toContainText("vs Boca Juniors");
    await expect(filas.nth(0)).toContainText(/ganó\s*2-1/i);
    // Terminado sin marcador cargado: no se muestra ningún número de goles
    await expect(filas.nth(1).getByRole("link")).toHaveAttribute("href", "/partidos/superclasico-sin-marcador");
    await expect(filas.nth(1)).toContainText("Terminado");
    await expect(filas.nth(1)).not.toContainText(/\d+-\d+/);
    const calendario = page.getByRole("region", { name: "En tu calendario", exact: true });
    await expect(calendario).toContainText("Si seguís a River Plate, sus partidos aparecen como eventos en tu Google Calendar u Outlook.");
    await expect(calendario).toContainText("una hora antes de cada partido y otra vez 15 minutos antes");
    await expect(calendario.locator('a[href="/calendario"]')).toBeVisible();
    await expect(calendario.getByRole("link", { name: "Iniciá sesión", exact: true })).toHaveAttribute("href", "/login?next=%2Fequipos%2Friver");
    // Un solo llamado a iniciar sesión para el calendario (el aviso viejo sobre la lista ya no está)
    await expect(page.getByText("Iniciá sesión para agregar estos partidos a tu calendario.")).toHaveCount(0);

    await page.goto("/calendario");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Tu fixture en Google Calendar y Outlook");
    await expect(page.getByRole("region", { name: "Cómo agregar los partidos a tu calendario" }).getByRole("listitem")).toHaveCount(4);
    await expect(page.getByRole("region", { name: "Descargar el fixture como archivo .ics" })).toContainText("no se actualizan solos");
    await page.goto("/");
    await expect(page.getByRole("main").locator('a[href="/equipos/river"]')).toBeVisible();
  } finally {
    await context.close();
  }
});

test("noindex en /cuenta con sesión", async ({ page }, info) => {
  await page.context().addCookies([{ name: "session", value: `e2e-${info.project.name}-preferences-${info.retry}`, url: BASE, httpOnly: true }]);
  await page.goto("/cuenta");
  await expect(page).toHaveURL(`${BASE}/cuenta`);
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
  const fecha = diaISO(new Date(evento.startDate)).split("-").reverse().join("/");
  expect(await page.title()).toContain(fecha);
  await expect(page.locator('time[datetime]')).toHaveAttribute("datetime", evento.startDate);
  await expect(page.getByText("Estado:").locator("..")).toContainText("Programado");
  // El fixture de matches usa el source por defecto, aunque equipos/ligas estén sembrados con ESPN.
  await expect(page.getByText("Datos:").locator("..")).toContainText("football-data.org");
});

test("descripciones de hasta 160 caracteres, sin undefined ni null", async ({ page }) => {
  for (const ruta of ["/", "/partidos/superclasico", "/partidos/superclasico-ida", "/partidos/superclasico-sin-marcador", "/equipos/river", "/ligas/e2e-league", "/partidos/neutral-match"]) {
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
  const datosEquipo = await jsonLd(page);
  expect(datosEquipo[0]["@type"]).toBe("SportsTeam");
  await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /^Partidos y fixture de River Plate \(Liga E2E\): próximo partido /);
  // docs/33 D6: los próximos partidos programados como SportsEvent, hasta 10, sin los ya jugados
  const eventos = datosEquipo.filter((d) => d["@type"] === "SportsEvent");
  expect(eventos.length).toBeGreaterThan(0);
  expect(eventos.length).toBeLessThanOrEqual(10);
  expect(eventos.map((e) => e.url)).toContain(`${BASE}/partidos/superclasico`);
  expect(eventos.map((e) => e.url)).not.toContain(`${BASE}/partidos/superclasico-ida`);
  expect(eventos.every((e) => e.eventStatus === "https://schema.org/EventScheduled")).toBe(true);
  // El filtro ?lado= no cambia los datos estructurados: River es local en el superclásico
  await page.goto("/equipos/river?lado=visitante");
  expect((await jsonLd(page)).filter((d) => d["@type"] === "SportsEvent").map((e) => e.url)).toEqual(eventos.map((e) => e.url));

  await page.goto("/ligas");
  expect(await jsonLd(page)).toEqual([]);
});

test("docs/33 T4-5: la página de equipo indexable no lleva noindex ni nosnippet", async ({ page }) => {
  const res = await page.goto("/equipos/river");
  expect(res?.status()).toBe(200);
  expect(res?.headers()["x-robots-tag"] ?? "").not.toMatch(/noindex|nosnippet/);
  await expect(page.locator('meta[name="robots"], meta[name="googlebot"], meta[name="bingbot"]')).toHaveCount(0);
  await expect(page.locator("[data-nosnippet]")).toHaveCount(0);
  expect(await page.content()).not.toMatch(/nosnippet|max-snippet:0/);
});

test("docs/33 D8: un equipo sin ningún partido se sirve con noindex y queda fuera del sitemap", async ({ page, request }) => {
  const res = await page.goto("/equipos/sin-partidos");
  expect(res?.status()).toBe(200);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
  await expect(page.getByRole("region", { name: "Próximo partido", exact: true })).toContainText(
    "Equipo sin partidos todavía no tiene un próximo partido confirmado. Aparece acá apenas se confirme el fixture."
  );
  await expect(page.getByRole("region", { name: "Últimos resultados", exact: true })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "En tu calendario", exact: true })).toBeVisible();
  const datos = await jsonLd(page);
  expect(datos.filter((d) => d["@type"] === "SportsEvent")).toEqual([]);

  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).not.toContain(`<loc>${BASE}/equipos/sin-partidos</loc>`);
  expect(sitemap).toContain(`<loc>${BASE}/equipos/boca</loc>`);
});

test("llms.txt y sitemap con páginas dinámicas", async ({ request }) => {
  const llms = await request.get("/llms.txt");
  expect(llms.status()).toBe(200);
  expect(await llms.text()).toMatch(/^# FISTURE\n/);

  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).toContain(`<loc>${BASE}/ligas/e2e-league</loc>`);
  expect(sitemap).toContain(`<loc>${BASE}/equipos/river</loc>`);
});

test.describe("docs/33 D9: URLs con nombre de equipos y ligas", () => {
  test("la URL con id responde 301 a la URL con nombre, conservando el query string", async ({ request }) => {
    const equipo = await request.get("/equipos/neutral-home?lado=local", { maxRedirects: 0 });
    expect(equipo.status()).toBe(301);
    expect(new URL(equipo.headers()["location"], BASE).pathname + new URL(equipo.headers()["location"], BASE).search).toBe("/equipos/equipo-neutral-local?lado=local");

    const liga = await request.get("/ligas/neutral-league", { maxRedirects: 0 });
    expect(liga.status()).toBe(301);
    expect(new URL(liga.headers()["location"], BASE).pathname).toBe("/ligas/liga-neutral");
  });

  test("por slug se sirve la página con la canónica, las migas y el JSON-LD con nombre", async ({ page }) => {
    const res = await page.goto("/equipos/equipo-neutral-local");
    expect(res?.status()).toBe(200);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${BASE}/equipos/equipo-neutral-local`);
    await expect(page.locator(".eq-mig").getByRole("link", { name: "Liga neutral" })).toHaveAttribute("href", "/ligas/liga-neutral");
    const datos = await jsonLd(page);
    const equipo = datos.find((d) => d["@type"] === "SportsTeam");
    expect(equipo).toMatchObject({ url: `${BASE}/equipos/equipo-neutral-local`, memberOf: { url: `${BASE}/ligas/liga-neutral` } });
    const migas = datos.find((d) => d["@type"] === "BreadcrumbList");
    expect(migas.itemListElement.map((i: { item: string }) => i.item)).toEqual([`${BASE}/ligas`, `${BASE}/ligas/liga-neutral`, `${BASE}/equipos/equipo-neutral-local`]);

    await page.goto("/ligas/liga-neutral");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${BASE}/ligas/liga-neutral`);
  });

  test("un equipo sin slug sigue funcionando por id y el partido enlaza a cada equipo por su URL pública", async ({ page }) => {
    const res = await page.goto("/equipos/neutral-away");
    expect(res?.status()).toBe(200);
    expect(res?.request().redirectedFrom()).toBeNull();
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `${BASE}/equipos/neutral-away`);

    await page.goto("/partidos/neutral-match");
    const main = page.getByRole("main");
    await expect(main.locator('a[href="/equipos/equipo-neutral-local"]').first()).toBeVisible();
    await expect(main.locator('a[href="/equipos/neutral-away"]').first()).toBeVisible();
    await expect(main.locator('a[href="/equipos/neutral-home"]')).toHaveCount(0);
    const partido = (await jsonLd(page)).find((d) => d["@type"] === "SportsEvent");
    expect(partido.homeTeam.url).toBe(`${BASE}/equipos/equipo-neutral-local`);
    expect(partido.superEvent.url).toBe(`${BASE}/ligas/liga-neutral`);
  });

  // Los equipos neutrales no participan de ninguna liga (sin league_teams), así que no entran al sitemap:
  // la URL de equipo con slug o sin slug en el sitemap se prueba en tests/integration/seo/sitemap-llms.test.ts
  test("el sitemap y llms.txt usan el slug de la liga en lugar del id", async ({ request }) => {
    const sitemap = await (await request.get("/sitemap.xml")).text();
    expect(sitemap).toContain(`<loc>${BASE}/ligas/liga-neutral</loc>`);
    expect(sitemap).not.toContain(`<loc>${BASE}/ligas/neutral-league</loc>`);
    const llms = await (await request.get("/llms.txt")).text();
    expect(llms).toContain(`](${BASE}/ligas/liga-neutral)`);
    expect(llms).not.toContain("/ligas/neutral-league");
  });
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

test("docs/29: cada página pública tiene título y descripción propios", async ({ page }) => {
  const rutas = ["/", "/hoy", "/partidos", "/ligas", "/calendario", "/equipos/buscar", "/ayuda", "/privacidad", "/terminos", "/ligas/e2e-league", "/equipos/river", "/partidos/superclasico"];
  const titulos = new Set<string>();
  const descripciones = new Set<string>();
  for (const ruta of rutas) {
    await page.goto(ruta);
    const titulo = await page.title();
    const descripcion = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
    expect(titulo.length, ruta).toBeLessThanOrEqual(60);
    expect(descripcion.length, ruta).toBeGreaterThan(50);
    expect(descripcion.length, ruta).toBeLessThanOrEqual(160);
    expect(descripcion, ruta).not.toMatch(/^Sincronizá los partidos de tus equipos/);
    titulos.add(titulo);
    descripciones.add(descripcion);
    await expect(page.locator('meta[name="robots"]'), ruta).toHaveCount(0);
  }
  expect(titulos.size).toBe(rutas.length);
  expect(descripciones.size).toBe(rutas.length);
});

test("docs/29: la home nombra la marca en texto y enlaza las secciones públicas", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/^FISTURE: fixture de fútbol/);
  await expect(page.getByRole("heading", { level: 2, name: "Qué es Fisture" })).toBeVisible();
  const seccion = page.getByRole("region", { name: "Qué es Fisture" });
  for (const href of ["/hoy", "/partidos", "/ligas", "/equipos/buscar"]) await expect(seccion.locator(`a[href="${href}"]`)).toHaveCount(1);
  const [sitio] = await jsonLd(page);
  expect(sitio["@graph"][1].logo.url).toBe(`${BASE}/icon-512.png`);
});

test("docs/29: meta de verificación de Search Console si está configurada, y la de Bing solo si existe", async ({ page }) => {
  await page.goto("/ligas");
  await expect(page.locator('meta[name="google-site-verification"]')).toHaveAttribute("content", "e2e-google-verificacion");
  await expect(page.locator('meta[name="msvalidate.01"]')).toHaveCount(0);
});

test("docs/33 paso 2: el partido responde, muestra el resultado y la hora por país sin JavaScript", async ({ browser }) => {
  const context = await browser.newContext({ javaScriptEnabled: false, baseURL: BASE });
  try {
    await context.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    const page = await context.newPage();
    const ficha = page.getByRole("complementary").filter({ hasText: "Ficha del partido" });
    const horas = page.getByRole("region", { name: "Hora en cada país", exact: true });
    const fixtures = page.getByRole("navigation", { name: "Fixture de los equipos", exact: true });

    // Programado: respuesta directa, horas por país calculadas con la zona de cada país y enlaces a los fixtures
    await page.goto("/partidos/superclasico");
    await expect(page.locator(".fp-respuesta")).toHaveText(
      /^River Plate y Boca Juniors juegan el [a-záé]+ \d+ de [a-z]+ a las \d{2}:\d{2} \(hora de Argentina\) por Liga E2E, en el estadio Monumental\.$/
    );
    const [evento] = await jsonLd(page);
    const esperado = horaPorPais(new Date(evento.startDate)).map((g) => `${horaConDia(g)} ${listaConY(g.paises)}`);
    await expect(horas.getByRole("listitem")).toHaveText(esperado);
    // Argentina primero, con Uruguay y Brasil (y Chile y Paraguay cuando comparten hora)
    await expect(horas.getByRole("listitem").first()).toContainText(/^\s*\d{2}:\d{2}\s+Argentina, Uruguay/);
    await expect(horas).toContainText("España (península)");
    await expect(fixtures.getByRole("link", { name: "Fixture y partidos de River Plate", exact: true })).toHaveAttribute("href", "/equipos/river");
    await expect(fixtures.getByRole("link", { name: "Fixture y partidos de Boca Juniors", exact: true })).toHaveAttribute("href", "/equipos/boca");
    await expect(ficha).not.toContainText("Resultado:");
    await expect(page.locator('meta[name="description"]')).toHaveAttribute("content", /Agregalo a tu calendario/);

    // Terminado con marcador (Boca 1, River 2): resultado en la ficha y junto al titular, sin hablar en futuro
    await page.goto("/partidos/superclasico-ida");
    await expect(page.locator(".fp-respuesta")).toHaveText(
      /^River Plate le ganó 2 a 1 a Boca Juniors el [a-záé]+ \d+ de [a-z]+, por Liga E2E, en el estadio La Bombonera\.$/
    );
    await expect(ficha).toContainText("Resultado: Boca Juniors 1, River Plate 2");
    await expect(ficha).toContainText("Estado: Finalizado");
    await expect(page.locator(".fp-marcador")).toHaveText(/^1\s*-\s*2$/);
    const descripcion = (await page.locator('meta[name="description"]').getAttribute("content")) ?? "";
    expect(descripcion).toMatch(/^Boca Juniors 1-2 River Plate por Liga E2E: se jugó el [a-záé]+ \d+ de [a-z]+ a las \d{2}:\d{2} \(hora argentina\) en La Bombonera\./);
    expect(descripcion).not.toContain("Agregalo");
    // Un partido terminado conserva la hora por país: dice cuándo se jugó en cada lugar
    const [jugado] = await jsonLd(page);
    await expect(horas.getByRole("listitem")).toHaveText(
      horaPorPais(new Date(jugado.startDate)).map((g) => `${horaConDia(g)} ${listaConY(g.paises)}`)
    );

    // Terminado sin marcador: no se inventa
    await page.goto("/partidos/superclasico-sin-marcador");
    await expect(page.locator(".fp-respuesta")).toContainText("El resultado todavía no está cargado.");
    await expect(ficha).not.toContainText("Resultado:");
    await expect(page.locator(".fp-marcador")).toHaveCount(0);
    await expect(page.getByText("VS", { exact: true })).toBeVisible();

    // Cancelado: lo dice y no muestra horas por país
    await page.goto("/partidos/desktop-calendar-states-0-cancelled");
    await expect(page.locator(".fp-respuesta")).toHaveText(/fue cancelado\.$/);
    await expect(horas).toHaveCount(0);

    // Equipo: hora por país del próximo partido, y la lista sigue en hora de Argentina
    await page.goto("/equipos/river");
    const proximo = page.getByRole("region", { name: "Próximo partido", exact: true });
    const compacto = esperado.map((t) => t.replace(/^(\d{2}:\d{2}(?: del [a-záé]+)?) /, "$1 en ")).join("; ");
    await expect(proximo.locator(".eq-horas")).toHaveText(`Hora en cada país: ${compacto}.`);
    await expect(proximo).toContainText("Los horarios de la lista de próximos partidos están en hora de Argentina (UTC−3).");
  } finally {
    await context.close();
  }
});
