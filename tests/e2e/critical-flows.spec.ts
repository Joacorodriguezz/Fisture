import { test, expect, type Page, type TestInfo, type Locator } from "@playwright/test";
import { diaISO, sumarDias } from "../../src/lib/format";

async function login(page: Page, info: TestInfo, scenario: string) {
  await page.context().addCookies([{ name: "session", value: `e2e-${info.project.name}-${scenario}-${info.retry}`, url: "http://127.0.0.1:4322", httpOnly: true }]);
}

async function ready(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  // client:visible: esperar únicamente la island que contiene el control que se va a usar.
  await expect(page.locator("astro-island[ssr]").filter({ has: control })).toHaveCount(0);
}

test.beforeEach(async ({ context }) => {
  // Los únicos requests del navegador son a la app local (fuentes externas se omiten).
  await context.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});

test("páginas públicas y redirección sin sesión", async ({ page }) => {
  for (const path of ["/", "/ayuda", "/privacidad", "/terminos", "/hoy", "/ligas", "/ligas/e2e-league", "/equipos/buscar", "/equipos/river", "/partidos", "/partidos/superclasico", "/calendario"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  await page.goto("/cuenta");
  await expect(page).toHaveURL(/\/login\?next=%2Fcuenta$/);
  await expect(page.getByRole("link", { name: /Continuar con Google/ })).toBeVisible();
});

test("/configuracion redirige a /cuenta con 301 y conserva la query (docs/31 D3)", async ({ page }, info) => {
  const respuesta = await page.request.get("/configuracion?vinculado=google", { maxRedirects: 0 });
  expect(respuesta.status()).toBe(301);
  expect(respuesta.headers()["location"]).toBe("/cuenta?vinculado=google");
  await login(page, info, "navigation");
  await page.goto("/configuracion");
  await expect(page).toHaveURL(/\/cuenta$/);
  await expect(page.getByRole("heading", { level: 1, name: "TU CUENTA" })).toBeVisible();
});

test("busca, sigue y deja de seguir un equipo con persistencia", async ({ page }, info) => {
  await login(page, info, "follow");
  await page.goto("/equipos/buscar");
  const search = page.getByRole("searchbox", { name: "Buscar equipos" });
  await ready(page, search);
  await search.fill("River");
  await expect(page.getByRole("button", { name: "Seguir", exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Seguir", exact: true }).click();
  await expect(page.getByText("✓ Siguiendo", { exact: true })).toBeVisible();
  await page.goto("/equipos/river");
  const unfollow = page.getByRole("button", { name: "Dejar de seguir", exact: true });
  await ready(page, unfollow);
  await expect(unfollow).toBeVisible();
  await page.getByRole("group", { name: "Auto-sync del equipo" }).getByRole("button", { name: /No$/ }).click();
  await expect(page.getByText("✓ Guardado", { exact: true })).toBeVisible();
  await page.reload();
  await ready(page, unfollow);
  await expect(page.getByRole("group", { name: "Auto-sync del equipo" }).getByRole("button", { name: /No$/ })).toHaveAttribute("aria-pressed", "true");
  await unfollow.click();
  await page.getByRole("group", { name: /Confirmar: dejar de seguir/ }).getByRole("button", { name: "Sí, dejar de seguir" }).click();
  await expect(page.getByRole("button", { name: "Seguir equipo", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Seguir equipo", exact: true })).toBeVisible();
});

test("guarda recordatorios y tema tras recargar", async ({ page }, info) => {
  await login(page, info, "preferences");
  await page.goto("/cuenta");
  const reminder = page.getByRole("group", { name: "Aviso 1 hora antes" }).getByRole("button", { name: /No$/ });
  await ready(page, reminder);
  await reminder.click();
  await expect(page.getByText("✓ Guardado", { exact: true })).toBeVisible();
  const theme = page.getByRole("group", { name: "Edición", exact: true }).getByRole("button", { name: "Pizarra" });
  await theme.click();
  await expect(theme).toBeEnabled();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "nocturna");
  await page.reload();
  await expect(reminder).toHaveAttribute("aria-pressed", "true");
  await expect(theme).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "nocturna");
});

test("consulta partidos y descarga un calendario real", async ({ page }, info) => {
  await login(page, info, "calendar");
  await page.goto("/calendario");
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "Descargar .ics", exact: true }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe("todos-los-partidos.ics");
  const stream = await file.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const content = Buffer.concat(chunks).toString("utf8");
  expect(content).toContain("BEGIN:VCALENDAR");
  expect(content).toContain("SUMMARY:River Plate vs Boca Juniors");
  expect(content).toContain("UID:superclasico@fisture.app");
});

test("navega por ligas, equipos y detalle del partido", async ({ page }, info) => {
  await login(page, info, "navigation");
  for (const path of ["/hoy", "/ligas", "/ligas/e2e-league", "/equipos", "/equipos/river", "/partidos", "/partidos/superclasico"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  await expect(page.getByText("Monumental", { exact: false }).first()).toBeVisible();
});

test("logout elimina la sesión del KV y rechaza reutilizarla", async ({ page }, info) => {
  await login(page, info, "logout");
  await page.goto("/cuenta");
  await page.getByRole("button", { name: "Cerrar sesión", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:4322/");
  await login(page, info, "logout");
  await page.goto("/cuenta");
  await expect(page).toHaveURL(/\/login\?next=%2Fcuenta$/);
});

test("elimina la cuenta tras confirmar con el email y la sesión deja de servir", async ({ page }, info) => {
  await login(page, info, "delete-account");
  const email = `${info.project.name}-delete-account-${info.retry}@example.test`;
  await page.goto("/cuenta");
  const abrir = page.getByRole("button", { name: "Eliminar mi cuenta", exact: true });
  await ready(page, abrir);
  await abrir.click();
  const dialogo = page.getByRole("dialog", { name: "¿Eliminar tu cuenta?" });
  await expect(dialogo).toBeVisible();
  const eliminar = dialogo.getByRole("button", { name: "Eliminar definitivamente", exact: true });
  await expect(eliminar).toBeDisabled();
  await dialogo.getByLabel(/Escribí tu email para confirmar/).fill("otro@example.test");
  await expect(eliminar).toBeDisabled();
  await dialogo.getByLabel(/Escribí tu email para confirmar/).fill(email.toUpperCase());
  await expect(eliminar).toBeEnabled();
  await eliminar.click();
  await expect(page).toHaveURL("http://127.0.0.1:4322/?cuenta=eliminada");
  await expect(page.getByRole("status")).toContainText("Tu cuenta se eliminó");
  // La sesión ya no abre Cuenta
  await login(page, info, "delete-account");
  await page.goto("/cuenta");
  await expect(page).toHaveURL(/\/login\?next=%2Fcuenta$/);
});

test("el diálogo de eliminar cuenta se cierra con Cancelar y no borra nada", async ({ page }, info) => {
  await login(page, info, "delete-cancel");
  await page.goto("/cuenta");
  const abrir = page.getByRole("button", { name: "Eliminar mi cuenta", exact: true });
  await ready(page, abrir);
  await abrir.click();
  const dialogo = page.getByRole("dialog", { name: "¿Eliminar tu cuenta?" });
  await dialogo.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(dialogo).toBeHidden();
  await page.reload();
  await expect(page.getByRole("heading", { level: 1, name: "TU CUENTA" })).toBeVisible();
});

test("un fallo de auth se informa y permite reintentar sin persistir un falso fallo del partido", async ({ page }, info) => {
  await login(page, info, "errors");
  await page.goto("/partidos/superclasico");
  await expect(page.locator("astro-island[ssr]")).toHaveCount(0);
  await page.getByRole("button", { name: "Agregar al calendario", exact: true }).click();
  await expect(page.getByRole("button", { name: "Reintentar", exact: true })).toBeVisible();
  await expect(page.getByText("Hay que volver a conectar el calendario", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Agregar al calendario", exact: true })).toBeVisible();
});

test("agregar desde la lista de partidos responde al toque", async ({ page }, info) => {
  // En móvil la fila aplana la island con display: contents: tiene que hidratarse igual (regresión).
  await login(page, info, "list-add");
  await page.goto("/partidos");
  const isla = page.locator(".pm-accion astro-island").first();
  await isla.scrollIntoViewIfNeeded();
  await expect(isla).not.toHaveAttribute("ssr");
  await isla.getByRole("button", { name: "Agregar", exact: true }).click();
  await expect(isla.getByRole("button", { name: "Reintentar", exact: true })).toBeVisible();
});

test("las copas no destacadas no se listan pero aparecen en el equipo", async ({ page }) => {
  await page.goto("/ligas");
  await expect(page.getByText("Liga E2E", { exact: true })).toBeVisible();
  await expect(page.getByText("Copa E2E", { exact: true })).toHaveCount(0);
  await page.goto("/equipos/river");
  await expect(page.getByText("Juega Liga E2E · Copa E2E", { exact: true })).toBeVisible();
});

test("las acciones personales piden login y conservan un retorno seguro", async ({ page }) => {
  await page.goto("/equipos/river");
  const follow = page.getByRole("button", { name: "Seguir equipo", exact: true });
  await ready(page, follow);
  await follow.click();
  await expect(page).toHaveURL(/\/login\?next=%2Fequipos%2Friver$/);
  await expect(page.getByRole("link", { name: /Continuar con Google/ })).toHaveAttribute("href", "/api/auth/login/google?next=%2Fequipos%2Friver");
  await page.goto("/login?next=https%3A%2F%2Fevil.example");
  await expect(page.getByRole("link", { name: /Continuar con Google/ })).toHaveAttribute("href", "/api/auth/login/google");
});

test("sesión inválida: lectura pública disponible, API personal devuelve JSON 401", async ({ page, context }) => {
  await context.addCookies([{ name: "session", value: "expired-session", url: "http://127.0.0.1:4322" }]);
  expect((await page.goto("/partidos/superclasico"))?.status()).toBe(200);
  expect((await context.cookies()).find((cookie) => cookie.name === "session")).toBeUndefined();
  const protectedResponse = await page.request.post("/api/calendario/sync", { data: { matchId: "superclasico" }, maxRedirects: 0 });
  expect(protectedResponse.status()).toBe(401);
  expect(await protectedResponse.json()).toEqual({ error: "Unauthorized" });
  const publicSearch = await page.request.get("/api/equipos/buscar?q=River");
  expect(publicSearch.status()).toBe(200);
  expect(await publicSearch.json()).toEqual([expect.objectContaining({ id: "river", isFollowing: false })]);
});

test("calendario refleja reprogramados, detached y cancelados sin reofrecerlos en lote", async ({ page }, info) => {
  await login(page, info, "calendar-states");
  const id = `${info.project.name}-calendar-states-${info.retry}`;
  // La vista detecta cambios como el cron: el synced tiene el horario anterior en la fixture.
  await page.goto("/calendario");
  await expect(page.getByRole("button", { name: "Actualizar", exact: true })).toHaveCount(1);
  await page.goto(`/partidos/${id}-synced`);
  await expect(page.getByRole("button", { name: "Actualizar evento", exact: true })).toBeVisible();
  await expect(page.getByText("↻ Reprogramado", { exact: true })).toBeVisible();
  await page.goto(`/partidos/${id}-detached`);
  await expect(page.getByRole("button", { name: "Agregar al calendario", exact: true })).toBeVisible();
  await page.goto(`/partidos/${id}-cancelled`);
  await expect(page.getByRole("button", { name: "Partido cancelado", exact: true })).toBeDisabled();
});

test("salud, auth administrativa y errores HTTP sobre el worker construido", async ({ request }) => {
  const health = await request.get("/api/health");
  expect(health.status()).toBe(200);
  expect(await health.json()).toMatchObject({ status: "ok", checks: { db: "ok", kv: "ok", sync: "ok", oauthState: "ok", tokenKey: "ok" } });
  expect((await request.get("/api/admin/status")).status()).toBe(401);
  const status = await request.get("/api/admin/status", { headers: { Authorization: "Bearer local-e2e-admin" } });
  expect(status.status()).toBe(200);
  expect((await request.post("/api/admin/sync", { data: {} })).status()).toBe(401);
});

test("login OAuth: el estado va en una cookie firmada y el callback lo exige", async ({ request }) => {
  const login = await request.get("/api/auth/login/google", { maxRedirects: 0 });
  expect(login.status()).toBe(302);
  expect(new URL(login.headers()["location"]).origin).toBe("https://accounts.google.com");
  const cookie = login.headers()["set-cookie"];
  expect(cookie).toMatch(/^oauth_state_google=/);
  expect(cookie).toMatch(/HttpOnly/i);
  expect(cookie).toMatch(/Path=\/api\/auth/i);

  // Sin la cookie del intento (o con otro state) el callback no avanza
  const callback = await request.get("/api/auth/callback/google?code=x&state=inventado", { maxRedirects: 0 });
  expect(callback.status()).toBe(302);
  expect(callback.headers()["location"]).toBe("/login?error=invalid_state");
});

// Los tests de viewport se separan por proyecto: cada uno cubre un solo comportamiento.
const soloMovil = () => test.skip(({ isMobile }) => !isMobile, "solo en el proyecto móvil");
const soloEscritorio = () => test.skip(({ isMobile }) => isMobile, "solo en el proyecto de escritorio");
const navegacionPrincipal = (page: Page) => page.getByRole("navigation", { name: "Secciones", exact: true });
const enlaceCuenta = (page: Page) => page.getByRole("link", { name: /^Tu cuenta/ });
const SECCIONES = ["Hoy", "Partidos", "Ligas", "Calendario"];

// docs/31 D1 y D2: cabecera compacta y fija; en mobile, barra inferior con Buscar al centro
test.describe("navegación responsive: móvil", () => {
  soloMovil();

  test("la barra inferior tiene las cuatro secciones y Buscar, y marca la actual", async ({ page }) => {
    await page.goto("/ligas");
    const barra = navegacionPrincipal(page);
    await expect(barra).toBeVisible();
    for (const label of SECCIONES) await expect(barra.getByRole("link", { name: label, exact: true })).toBeVisible();
    await expect(barra.getByRole("link", { name: "Ligas", exact: true })).toHaveAttribute("aria-current", "page");
    await barra.getByRole("link", { name: "Buscar equipo", exact: true }).click();
    await expect(page).toHaveURL(/\/equipos\/buscar$/);
    await expect(navegacionPrincipal(page).getByRole("link", { name: "Buscar equipo", exact: true })).toHaveAttribute("aria-current", "page");
    await navegacionPrincipal(page).getByRole("link", { name: "Calendario", exact: true }).click();
    await expect(page).toHaveURL(/\/calendario$/);
  });

  test("la barra queda fija abajo y no tapa el pie de la página", async ({ page }) => {
    await page.goto("/ayuda");
    const barra = navegacionPrincipal(page);
    const viewport = page.viewportSize()!;
    const caja = (await barra.boundingBox())!;
    expect(Math.round(caja.y + caja.height)).toBe(viewport.height);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const pie = (await page.locator(".tb-footer").boundingBox())!;
    expect(pie.y + pie.height).toBeLessThanOrEqual((await barra.boundingBox())!.y + 1);
  });

  test("sin sesión la cabecera ofrece ingresar; con sesión, el avatar lleva a Cuenta", async ({ page }, info) => {
    await page.goto("/ligas");
    await expect(page.getByRole("banner").getByRole("link", { name: "Iniciar sesión", exact: true })).toBeVisible();
    await login(page, info, "responsive-menu");
    await page.goto("/ligas");
    await enlaceCuenta(page).click();
    await expect(page).toHaveURL(/\/cuenta$/);
    await expect(page.getByRole("heading", { level: 1, name: "TU CUENTA" })).toBeVisible();
  });
});

test.describe("navegación responsive: escritorio", () => {
  soloEscritorio();

  test("no hay barra inferior y la navegación de la cabecera lleva a Calendario", async ({ page }) => {
    await page.goto("/ligas");
    await expect(page.locator(".tb-barra-inferior")).toBeHidden();
    const nav = navegacionPrincipal(page);
    for (const label of SECCIONES) await expect(nav.getByRole("link", { name: label, exact: true })).toBeVisible();
    await nav.getByRole("link", { name: "Calendario", exact: true }).click();
    await expect(page).toHaveURL(/\/calendario$/);
  });

  test("el buscador de la cabecera lleva a Buscar", async ({ page }) => {
    await page.goto("/hoy");
    await page.getByRole("banner").getByRole("link", { name: "Buscar equipo", exact: true }).click();
    await expect(page).toHaveURL(/\/equipos\/buscar$/);
  });

  test("la cabecera queda fija al hacer scroll", async ({ page }) => {
    await page.goto("/ayuda");
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    expect((await page.getByRole("banner").boundingBox())!.y).toBe(0);
  });

  test("con sesión el avatar saluda y lleva a Cuenta", async ({ page }, info) => {
    await login(page, info, "responsive-menu");
    await page.goto("/ligas");
    await expect(page.getByRole("banner").getByText(/^Hola, /)).toBeVisible();
    await enlaceCuenta(page).click();
    await expect(page).toHaveURL(/\/cuenta$/);
    await expect(page.getByRole("heading", { level: 1, name: "TU CUENTA" })).toBeVisible();
  });
});

// Día del partido sembrado, calculado desde la API como lo vería el usuario
async function diaDelSuperclasico(page: Page) {
  const response = await page.request.get("/api/partidos");
  expect(response.status()).toBe(200);
  const upcoming = (await response.json()) as { id: string; dateTime: string }[];
  return diaISO(new Date(upcoming.find((match) => match.id === "superclasico")!.dateTime));
}

test.describe("Hoy: móvil", () => {
  soloMovil();
  const vista = (page: Page) => page.locator(".tb-solo-movil");

  test("las ligas recuerdan su estado plegado tras recargar", async ({ page }, info) => {
    await login(page, info, "responsive-today");
    const day = await diaDelSuperclasico(page);
    await page.goto(`/hoy?fecha=${day}`);
    const view = vista(page);
    const league = view.getByRole("button", { name: /^Liga E2E .*partidos?$/ });
    await ready(page, league);
    await expect(league).toHaveAttribute("aria-expanded", "true");
    await expect(view.getByRole("navigation", { name: "Cambiar de día" }).locator('[aria-current="date"]')).toHaveAttribute("href", `/hoy?fecha=${day}`);
    await league.click();
    await expect(league).toHaveAttribute("aria-expanded", "false");
    await expect(league.locator("..").locator(".hm-partido")).toHaveCount(0);
    await page.reload();
    await ready(page, league);
    await expect(league).toHaveAttribute("aria-expanded", "false");
  });

  test("el chip de la liga la vuelve a desplegar y se ven las demás ligas", async ({ page }, info) => {
    await login(page, info, "responsive-today-chip");
    const day = await diaDelSuperclasico(page);
    await page.goto(`/hoy?fecha=${day}`);
    const view = vista(page);
    const league = view.getByRole("button", { name: /^Liga E2E .*partidos?$/ });
    await ready(page, league);
    await league.click();
    await expect(league).toHaveAttribute("aria-expanded", "false");
    await view.locator(".hm-chips").getByRole("button", { name: /^Liga E2E/ }).click();
    await expect(league).toHaveAttribute("aria-expanded", "true");
    await expect(view.getByRole("button", { name: /^Liga neutral .*partidos?$/ })).toBeVisible();
  });

  test("Mis equipos oculta las ligas ajenas y conserva el filtro al cambiar de día", async ({ page }, info) => {
    await login(page, info, "responsive-today-mine");
    const day = await diaDelSuperclasico(page);
    await page.goto(`/hoy?fecha=${day}`);
    const view = vista(page);
    await view.getByRole("link", { name: "Mis equipos", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/hoy\\?fecha=${day}&solo=mios$`));
    await expect(view.getByRole("button", { name: /^Liga neutral/ })).toHaveCount(0);
    const nextDay = sumarDias(day, 1);
    await view.getByRole("navigation", { name: "Cambiar de día" }).locator(`a[href="/hoy?fecha=${nextDay}&solo=mios"]`).click();
    await expect(page).toHaveURL(new RegExp(`/hoy\\?fecha=${nextDay}&solo=mios$`));
  });
});

test.describe("Hoy: escritorio", () => {
  soloEscritorio();
  const vista = (page: Page) => page.locator(".tb-solo-escritorio");

  test("muestra todas las ligas del día", async ({ page }, info) => {
    await login(page, info, "responsive-today");
    const day = await diaDelSuperclasico(page);
    await page.goto(`/hoy?fecha=${day}`);
    await expect(vista(page).getByRole("heading", { name: /Liga neutral/ })).toBeVisible();
  });

  test("Mis equipos oculta las ligas ajenas y conserva el filtro al cambiar de día", async ({ page }, info) => {
    await login(page, info, "responsive-today-mine");
    const day = await diaDelSuperclasico(page);
    await page.goto(`/hoy?fecha=${day}`);
    const view = vista(page);
    await view.getByRole("link", { name: "Mis equipos", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/hoy\\?fecha=${day}&solo=mios$`));
    await expect(view.getByRole("heading", { name: /Liga neutral/ })).toHaveCount(0);
    await view.getByRole("link", { name: /Día siguiente/ }).click();
    await expect(page).toHaveURL(new RegExp(`/hoy\\?fecha=${sumarDias(day, 1)}&solo=mios$`));
  });
});

test("las pantallas principales no desbordan el viewport", async ({ page }) => {
  for (const path of ["/", "/ayuda", "/login", "/ligas", "/equipos/buscar", "/equipos/river", "/partidos/superclasico", "/calendario", "/hoy"]) {
    await page.goto(path);
    const sizes = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(sizes.content, path).toBeLessThanOrEqual(sizes.viewport + 1);
  }
});

test("un 429 al agregar al calendario muestra la espera en un mensaje legible", async ({ page }, info) => {
  await login(page, info, "calendar");
  await page.route("**/api/calendario/sync", (route) =>
    route.fulfill({ status: 429, headers: { "Retry-After": "37", "Content-Type": "application/json" }, body: JSON.stringify({ error: "rate_limited", retryAfter: 37 }) })
  );
  await page.goto("/partidos/superclasico");
  const agregar = page.getByRole("button", { name: /^Agregar/ });
  await ready(page, agregar);
  await agregar.click();
  await expect(page.getByText("Demasiados intentos. Probá de nuevo en 37 segundos.")).toBeVisible();
});

test("quitar del calendario: Cancelar devuelve el foco, el error permite reintentar y confirmar vuelve a Agregar", async ({ page }, info) => {
  await login(page, info, "quit");
  let borrados = 0;
  let liberar!: () => void;
  const espera = new Promise<void>((resolve) => { liberar = resolve; });
  await page.route("**/api/calendario/sync**", async (route) => {
    const metodo = route.request().method();
    if (metodo === "POST") return route.fulfill({ json: { results: [{ matchId: "superclasico", success: true }] } });
    borrados++;
    if (borrados === 1) return route.fulfill({ status: 500, json: { error: "boom" } });
    await espera;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/partidos/superclasico");
  const agregar = page.getByRole("button", { name: "Agregar al calendario", exact: true });
  await ready(page, agregar);
  await agregar.click();
  const quitar = page.getByRole("button", { name: "Quitar del calendario", exact: true });
  await expect(quitar).toBeVisible();

  // Cancelar vuelve al estado inicial con el foco en el disparador
  await quitar.click();
  const grupo = page.getByRole("group", { name: "Confirmar: quitar del calendario" });
  await expect(grupo.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
  await grupo.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(grupo).toHaveCount(0);
  await expect(quitar).toBeFocused();

  // Un error cierra la confirmación, muestra el mensaje y deja reintentar
  await quitar.click();
  await grupo.getByRole("button", { name: "Sí, quitar", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("boom");
  await expect(quitar).toBeFocused();

  // Confirmar: "Quitando…" y después vuelve el botón de agregar con el foco
  await quitar.click();
  await grupo.getByRole("button", { name: "Sí, quitar", exact: true }).click();
  await expect(grupo.getByRole("button", { name: "Quitando…", exact: true })).toBeDisabled();
  liberar();
  await expect(agregar).toBeVisible();
  await expect(agregar).toBeFocused();
  await expect(quitar).toHaveCount(0);
});

test("desvincular un proveedor: Cancelar devuelve el foco, el error permite reintentar y confirmar desvincula", async ({ page }, info) => {
  await login(page, info, "unlink");
  let intentos = 0;
  await page.route("**/api/auth/identidades/microsoft", (route) => {
    intentos++;
    return intentos === 1 ? route.fulfill({ status: 500, json: { error: "boom" } }) : route.continue();
  });
  await page.goto("/cuenta");
  const desvincular = page.getByRole("button", { name: "Desvincular", exact: true });
  await ready(page, desvincular);

  await desvincular.click();
  const grupo = page.getByRole("group", { name: "Confirmar: desvincular Microsoft" });
  await expect(grupo.getByRole("button", { name: "Cancelar", exact: true })).toBeFocused();
  await grupo.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(grupo).toHaveCount(0);
  await expect(desvincular).toBeFocused();

  await desvincular.click();
  await grupo.getByRole("button", { name: "Sí, desvincular", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "No se pudo desvincular" })).toBeVisible();
  await expect(desvincular).toBeFocused();

  await desvincular.click();
  await grupo.getByRole("button", { name: "Sí, desvincular", exact: true }).click();
  await expect(page).toHaveURL(/\/cuenta$/);
  await expect(page.getByText("Sin vincular").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Desvincular", exact: true })).toHaveCount(0);
});
