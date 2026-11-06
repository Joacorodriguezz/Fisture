import { test, expect, type Page, type TestInfo, type Locator } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { diaISO } from "../../../src/lib/format";

async function login(page: Page, info: TestInfo, scenario: string) {
  await page.context().addCookies([{ name: "session", value: `e2e-${info.project.name}-${scenario}-0`, url: "http://127.0.0.1:4322", httpOnly: true }]);
}

async function ready(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(page.locator("astro-island[ssr]").filter({ has: control })).toHaveCount(0);
}

test.beforeEach(async ({ context }) => {
  // Permitir las fuentes reales de la interfaz. Nunca llamar proveedores OAuth/calendario.
  await context.route(/https?:\/\//, (route) => {
    const host = new URL(route.request().url()).hostname;
    return ["127.0.0.1", "fonts.googleapis.com", "fonts.gstatic.com"].includes(host) ? route.continue() : route.abort();
  });
});

const screens = [
  { name: "portada", path: "/", session: false },
  { name: "login", path: "/login", session: false },
  { name: "ayuda", path: "/ayuda", session: false },
  { name: "privacidad", path: "/privacidad", session: false },
  { name: "terminos", path: "/terminos", session: false },
  { name: "ligas", path: "/ligas", session: false },
  { name: "buscar", path: "/equipos/buscar", session: false },
  { name: "equipo", path: "/equipos/river", session: false },
  { name: "proximos-partidos", path: "/partidos", session: false },
  { name: "partido", path: "/partidos/superclasico", session: true },
  { name: "calendario-publico", path: "/calendario", session: false },
  { name: "calendario-personal", path: "/calendario", session: true },
  { name: "configuracion", path: "/configuracion", session: true },
];

for (const theme of ["papel", "nocturna"]) {
  for (const screen of screens) {
    test(`${screen.name}: accesibilidad y evidencia visual (${theme})`, async ({ page }, info) => {
      if (screen.session) await login(page, info, "navigation");
      const response = await page.goto(screen.path);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      // Auditoría de ambos temas sin modificar preferencias del usuario de otra prueba.
      await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
      await page.evaluate(() => document.fonts.ready);
      await page.locator("main").scrollIntoViewIfNeeded();
      // Hidratar las islands visibles antes del análisis.
      const input = page.getByRole("searchbox", { name: "Buscar equipos" });
      if (screen.name === "buscar") await ready(page, input);
      const metrics = await page.evaluate(() => ({
        viewport: document.documentElement.clientWidth,
        content: document.documentElement.scrollWidth,
        fonts: document.fonts.status,
        fontFaces: [...document.fonts].map((font) => ({ family: font.family, status: font.status })),
        smallTargets: [...document.querySelectorAll<HTMLElement>("button,a,input,select")]
          .filter((element) => element.getClientRects().length > 0)
          .map((element) => ({ text: element.getAttribute("aria-label") || element.innerText || element.getAttribute("placeholder"), width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }))
          .filter((element) => element.width < 44 || element.height < 44),
      }));
      await info.attach("layout-y-controles", { body: JSON.stringify(metrics, null, 2), contentType: "application/json" });
      await info.attach("pantalla", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      const result = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
      await info.attach("axe", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
      expect.soft(metrics.content, "No debe existir desborde horizontal").toBeLessThanOrEqual(metrics.viewport + 1);
      expect(result.violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map((node) => node.target) }))).toEqual([]);
    });
  }
}

test("menú móvil: el foco permanece dentro hasta cerrar", async ({ page, isMobile }, info) => {
  test.skip(!isMobile, "El menú solo existe en móvil");
  await page.goto("/ligas");
  const open = page.getByRole("button", { name: "Abrir menú" });
  await open.click();
  const dialog = page.getByRole("dialog", { name: "Menú", exact: true });
  await expect(dialog).toHaveAttribute("open", "");
  await page.screenshot({ path: info.outputPath("menu.png") });
  await expect(dialog.getByRole("button", { name: /Cerrar/ })).toBeFocused();
  // Desde el primer control, Shift+Tab debe ir al último del modal, sin salir al fondo.
  await page.keyboard.press("Shift+Tab");
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button", { name: /Cerrar/ })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(open).toBeFocused();
});

test("búsqueda: un fallo conserva la consulta y permite reintentar", async ({ page }, info) => {
  await login(page, info, "follow");
  await page.goto("/equipos/buscar");
  const search = page.getByRole("searchbox", { name: "Buscar equipos" });
  await ready(page, search);
  await search.fill("River");
  await expect(page.getByRole("button", { name: "Seguir", exact: true })).toHaveCount(1);
  await page.route("**/api/equipos", (route) => route.request().method() === "POST" ? route.fulfill({ status: 503, json: { error: "Servicio no disponible" } }) : route.continue());
  await page.getByRole("button", { name: "Seguir", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText("No se pudo seguir el equipo. Probá de nuevo.");
  await expect(search).toHaveValue("River");
  await expect(page.getByRole("button", { name: "Seguir", exact: true })).toBeEnabled();
  await info.attach("error-al-seguir", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.unroute("**/api/equipos");
  const retry = page.waitForResponse((response) => response.url().endsWith("/api/equipos") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Seguir", exact: true }).click();
  expect((await retry).status()).toBe(201);
  await expect(page.getByText("✓ Siguiendo", { exact: true })).toBeVisible({ timeout: 15_000 });
});

test("búsqueda: sin resultados permite limpiar filtros", async ({ page }) => {
  await page.goto("/equipos/buscar");
  const search = page.getByRole("searchbox", { name: "Buscar equipos" });
  await ready(page, search);
  await search.fill("zzzz-equipo-inexistente");
  await expect(page.getByText(/Ningún equipo coincide/)).toBeVisible();
  await page.getByRole("button", { name: "Limpiar filtros" }).click();
  await expect(search).toHaveValue("");
  await expect(page.getByRole("button", { name: "Seguir", exact: true }).first()).toBeVisible();
});

test("sincronizar: muestra progreso, bloquea duplicados y recupera un fallo de red", async ({ page }, info) => {
  await login(page, info, "errors");
  await page.goto("/partidos/superclasico");
  const add = page.getByRole("button", { name: "Agregar al calendario", exact: true });
  await ready(page, add);
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/calendario/sync", async (route) => {
    calls++;
    if (calls === 1) { await pending; await route.abort("failed"); }
    else await route.fulfill({ json: { results: [{ matchId: "superclasico", success: true }] } });
  });
  await add.click();
  try {
    await expect(page.getByRole("button", { name: "Agregando…", exact: true })).toBeDisabled();
    expect(calls).toBe(1);
    await info.attach("sincronizacion-en-progreso", { body: await page.screenshot(), contentType: "image/png" });
  } finally { release(); }
  await expect(page.getByRole("alert")).toHaveText("Error de conexión");
  await page.getByRole("button", { name: "Reintentar", exact: true }).click();
  await expect(page.getByRole("button", { name: "En tu calendario", exact: true })).toBeDisabled();
  await expect(page.getByRole("status").filter({ hasText: "En tu calendario" })).toBeVisible();
  expect(calls).toBe(2);
});

test("sesión vencida: conserva el destino al pedir login", async ({ page }, info) => {
  await login(page, info, "errors");
  await page.goto("/partidos/superclasico");
  const add = page.getByRole("button", { name: "Agregar al calendario", exact: true });
  await ready(page, add);
  // La sesión realmente deja de viajar al servidor después de renderizar la pantalla.
  await page.context().clearCookies();
  await add.click();
  await expect(page).toHaveURL(/\/login\?next=%2Fpartidos%2Fsuperclasico$/);
});

test("eliminar cuenta: un fallo conserva el email y permite cancelar", async ({ page }, info) => {
  await login(page, info, "delete-cancel");
  await page.goto("/configuracion");
  const open = page.getByRole("button", { name: "Eliminar mi cuenta", exact: true });
  await ready(page, open);
  await open.click();
  const dialog = page.getByRole("dialog", { name: "¿Eliminar tu cuenta?" });
  const input = dialog.getByLabel(/Escribí tu email/);
  const email = `${info.project.name}-delete-cancel-0@example.test`;
  await input.fill(email);
  await page.route("**/api/cuenta", (route) => route.fulfill({ status: 503, json: { error: "Servicio no disponible" } }));
  await dialog.getByRole("button", { name: "Eliminar definitivamente" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("No se pudo eliminar la cuenta. Probá de nuevo.");
  await expect(input).toHaveValue(email);
  await dialog.getByRole("button", { name: "Cancelar", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(open).toBeFocused();
});

test("Hoy: volver desde un partido conserva fecha y filtro", async ({ page }, info) => {
  await login(page, info, "responsive-today-mine");
  const matches = await (await page.request.get("/api/partidos")).json() as { id: string; dateTime: string }[];
  const day = diaISO(new Date(matches.find((match) => match.id === "superclasico")!.dateTime));
  await page.goto(`/hoy?fecha=${day}&solo=mios`);
  await page.locator("main").getByRole("link").filter({ hasText: /River Plate/ }).first().click();
  await expect(page).toHaveURL(/\/partidos\/superclasico$/);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/hoy\\?fecha=${day}&solo=mios$`));
});

for (const theme of ["papel", "nocturna"]) {
  for (const width of [320, 375]) {
    for (const signedIn of [false, true]) {
      test(`Próximos partidos: hora y nombres completos a ${width}px (${theme}, ${signedIn ? "con sesión" : "visitante"})`, async ({ page }, info) => {
        await page.setViewportSize({ width, height: 812 });
        if (signedIn) await login(page, info, "navigation");
        await page.goto("/partidos");
        await page.evaluate((value) => document.documentElement.dataset.theme = value, theme);
        await page.evaluate(() => document.fonts.ready);
        const matchId = signedIn ? "superclasico" : "neutral-match";
        const row = page.locator(".pm-fila").filter({ has: page.locator(`.pm-enlace[href="/partidos/${matchId}"]`) });
        await expect(row).toBeVisible();
        if (signedIn) await ready(page, row.getByRole("button", { name: "Agregar", exact: true }));
        const time = await row.locator(".pm-hora").evaluate((element) => {
          const range = document.createRange();
          range.selectNodeContents(element);
          return { boxWidth: element.getBoundingClientRect().width, textWidth: range.getBoundingClientRect().width };
        });
        expect(time.textWidth, "La hora no debe invadir la columna de los equipos").toBeLessThanOrEqual(time.boxWidth + 1);
        // Por debajo de 360px el visitante no ve el "Iniciá sesión" de cada fila: ya está el enlace arriba de la lista
        const sinAccion = !signedIn && width < 360;
        if (sinAccion) {
          await expect(row.locator(".pm-login")).toBeHidden();
          await expect(page.getByRole("link", { name: "Iniciá sesión", exact: true }).first()).toBeVisible();
        }
        const positions = await row.evaluate((element, sinAccion) => {
          const rect = (selector: string) => element.querySelector(selector)!.getBoundingClientRect();
          const teams = rect(".pm-equipos");
          const time = rect(".pm-hora");
          const action = sinAccion ? null : rect(".pm-login, .pm-accion button");
          return { teamsRight: teams.right, actionLeft: action?.left ?? 0, teamsCenter: teams.y + teams.height / 2, timeCenter: time.y + time.height / 2, actionCenter: action ? action.y + action.height / 2 : 0 };
        }, sinAccion);
        expect(Math.abs(positions.timeCenter - positions.teamsCenter), "La hora debe centrarse entre los dos equipos").toBeLessThan(1);
        if (!sinAccion) {
          expect(positions.actionLeft, "La acción debe quedar a la derecha de los equipos").toBeGreaterThan(positions.teamsRight);
          expect(Math.abs(positions.actionCenter - positions.teamsCenter), "La acción debe centrarse entre los dos equipos").toBeLessThan(1);
        }
        const names = row.locator(".pm-nombre");
        await expect(names).toHaveCount(2);
        // Someter la fila a nombres largos, sin depender de datos de proveedores externos.
        await names.first().evaluate((element) => { element.textContent = "Club Atletico de la Ciudad de Buenos Aires"; });
        for (const name of await names.all()) {
          const size = await name.evaluate((element) => ({ content: element.scrollWidth, width: element.clientWidth }));
          expect(size.content, "El nombre debe ajustar dentro de su columna").toBeLessThanOrEqual(size.width + 1);
        }
        await row.screenshot({ path: info.outputPath("fila-partido.png") });
        await info.attach("fila-partido", { path: info.outputPath("fila-partido.png"), contentType: "image/png" });
      });
    }
  }
}

for (const width of [320, 375, 768, 1280]) {
  test(`reflow: pantallas principales a ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await login(page, info, "navigation");
    for (const path of ["/equipos/buscar", "/equipos/river", "/partidos", "/partidos/superclasico", "/calendario", "/configuracion"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const size = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
      await info.attach(`${path.replaceAll("/", "-")}-${width}px`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
      expect.soft(size.content, `${path} a ${width}px`).toBeLessThanOrEqual(size.viewport + 1);
    }
  });
}
