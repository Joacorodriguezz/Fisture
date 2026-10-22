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
  for (const path of ["/", "/privacidad", "/terminos", "/hoy", "/ligas", "/ligas/e2e-league", "/equipos/buscar", "/equipos/river", "/partidos", "/partidos/superclasico", "/calendario"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  }
  await page.goto("/configuracion");
  await expect(page).toHaveURL(/\/login\?next=%2Fconfiguracion$/);
  await expect(page.getByRole("link", { name: /Continuar con Google/ })).toBeVisible();
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
  await page.getByRole("alertdialog").getByRole("button", { name: "Sí, dejar de seguir" }).click();
  await expect(page.getByRole("button", { name: "Seguir equipo", exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Seguir equipo", exact: true })).toBeVisible();
});

test("guarda recordatorios y tema tras recargar", async ({ page }, info) => {
  await login(page, info, "preferences");
  await page.goto("/configuracion");
  const reminder = page.getByRole("group", { name: "Aviso 1 hora antes" }).getByRole("button", { name: /No$/ });
  await ready(page, reminder);
  await reminder.click();
  await expect(page.getByText("✓ Guardado", { exact: true })).toBeVisible();
  const theme = page.getByRole("group", { name: "Edición", exact: true }).getByRole("button", { name: "Nocturna" });
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
  await page.goto("/configuracion");
  await page.getByRole("link", { name: "Cerrar sesión", exact: true }).click();
  await expect(page).toHaveURL("http://127.0.0.1:4322/");
  await login(page, info, "logout");
  await page.goto("/configuracion");
  await expect(page).toHaveURL(/\/login\?next=%2Fconfiguracion$/);
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
  expect(await health.json()).toMatchObject({ status: "ok", checks: { db: "ok", kv: "ok", sync: "ok" } });
  expect((await request.get("/api/admin/status")).status()).toBe(401);
  const status = await request.get("/api/admin/status", { headers: { Authorization: "Bearer local-e2e-admin" } });
  expect(status.status()).toBe(200);
  expect((await request.post("/api/admin/sync", { data: {} })).status()).toBe(401);
});

test("navegación responsive: menú accesible, cierre y cuenta autenticada", async ({ page }, info) => {
  await page.goto("/ligas");
  const open = page.getByRole("button", { name: "Abrir menú", exact: true });
  const panel = page.getByRole("dialog", { name: "Menú", exact: true });
  if (info.project.name === "mobile") {
    await open.click();
    await expect(open).toHaveAttribute("aria-expanded", "true");
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("link", { name: "Iniciar sesión", exact: true })).toBeVisible();
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(open).toBeFocused();
    await expect(open).toHaveAttribute("aria-expanded", "false");
    await open.click();
    await panel.getByRole("link", { name: /^Calendario/ }).click();
    await expect(page).toHaveURL(/\/calendario$/);
    await expect(panel).toBeHidden();
  } else {
    await expect(open).toBeHidden();
    await page.getByRole("navigation", { name: "Secciones", exact: true }).getByRole("link", { name: "Calendario", exact: true }).click();
    await expect(page).toHaveURL(/\/calendario$/);
  }
  await login(page, info, "responsive-menu");
  await page.goto("/ligas");
  if (info.project.name === "mobile") {
    await open.click();
    await expect(panel.getByText(`${info.project.name}-responsive-menu-${info.retry}@example.test`, { exact: true })).toBeVisible();
    await panel.getByRole("link", { name: /^Configuración/ }).click();
  } else {
    await page.getByRole("navigation", { name: "Secciones", exact: true }).getByRole("link", { name: "Configuración", exact: true }).click();
  }
  await expect(page).toHaveURL(/\/configuracion$/);
  await expect(page.getByRole("heading", { level: 1, name: "TU CUENTA" })).toBeVisible();
});

test("Hoy conserva día y filtros; las ligas móviles recuerdan su estado", async ({ page }, info) => {
  await login(page, info, "responsive-today");
  const response = await page.request.get("/api/partidos");
  expect(response.status()).toBe(200);
  const upcoming = await response.json() as { id: string; dateTime: string }[];
  const kickoff = upcoming.find((match) => match.id === "superclasico")!.dateTime;
  const day = diaISO(new Date(kickoff));
  await page.goto(`/hoy?fecha=${day}`);
  const view = page.locator(info.project.name === "mobile" ? ".tb-solo-movil" : ".tb-solo-escritorio");
  if (info.project.name === "mobile") {
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
    await view.locator(".hm-chips").getByRole("button", { name: /^Liga E2E/ }).click();
    await expect(league).toHaveAttribute("aria-expanded", "true");
    await expect(view.getByRole("button", { name: /^Liga neutral .*partidos?$/ })).toBeVisible();
  } else {
    await expect(view.getByRole("heading", { name: /Liga neutral/ })).toBeVisible();
  }
  await view.getByRole("link", { name: "Mis equipos", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/hoy\\?fecha=${day}&solo=mios$`));
  if (info.project.name === "mobile") {
    await expect(view.getByRole("button", { name: /^Liga neutral/ })).toHaveCount(0);
    const nextDay = sumarDias(day, 1);
    await view.getByRole("navigation", { name: "Cambiar de día" }).locator(`a[href="/hoy?fecha=${nextDay}&solo=mios"]`).click();
    await expect(page).toHaveURL(new RegExp(`/hoy\\?fecha=${nextDay}&solo=mios$`));
  } else {
    await expect(view.getByRole("heading", { name: /Liga neutral/ })).toHaveCount(0);
    await view.getByRole("link", { name: /Día siguiente/ }).click();
    await expect(page).toHaveURL(new RegExp(`/hoy\\?fecha=${sumarDias(day, 1)}&solo=mios$`));
  }
});

test("las pantallas principales no desbordan el viewport", async ({ page }) => {
  for (const path of ["/", "/login", "/ligas", "/equipos/buscar", "/equipos/river", "/partidos/superclasico", "/calendario", "/hoy"]) {
    await page.goto(path);
    const sizes = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    expect(sizes.content, path).toBeLessThanOrEqual(sizes.viewport + 1);
  }
});
