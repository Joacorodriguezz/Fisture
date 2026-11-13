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
  { name: "liga-fixture", path: "/ligas/e2e-league", session: false },
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
  await expect(page.getByRole("alert")).toHaveText("Sin conexión. Revisá tu internet y probá de nuevo.");
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

for (const width of [320, 375]) {
  test(`partido: nombres largos y escudos entran a ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/partidos/superclasico");
    const titulo = page.getByRole("heading", { level: 1 });
    await expect(titulo).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    // Nombres reales de ESPN: una palabra de 15 letras no puede partirse por espacios.
    await titulo.evaluate((element) => { element.textContent = "Hamburger SV vs Borussia Mönchengladbach"; });
    const medidas = await page.evaluate(() => {
      const main = document.querySelector("main")!;
      const padding = parseFloat(getComputedStyle(main).paddingRight);
      const h1 = document.querySelector("h1")!;
      return {
        content: document.documentElement.scrollWidth,
        viewport: document.documentElement.clientWidth,
        tituloContent: h1.scrollWidth,
        tituloWidth: h1.clientWidth,
        escudosRight: document.querySelector("main .tb-escudo")!.parentElement!.getBoundingClientRect().right,
        limite: main.getBoundingClientRect().right - padding,
      };
    });
    await info.attach(`partido-largo-${width}px`, { body: await page.screenshot(), contentType: "image/png" });
    expect(medidas.tituloContent, "El titular debe ajustar dentro de su caja").toBeLessThanOrEqual(medidas.tituloWidth + 1);
    expect(medidas.content, "Sin desborde horizontal").toBeLessThanOrEqual(medidas.viewport + 1);
    expect(medidas.escudosRight, "Los escudos deben respetar el margen").toBeLessThanOrEqual(medidas.limite + 1);
  });
}

test("partido: equipos y competencia llevan a sus páginas", async ({ page }) => {
  await page.goto("/partidos/superclasico");
  const equipos = page.getByRole("heading", { level: 1 }).getByRole("link");
  await expect(equipos).toHaveCount(2);
  for (const enlace of await equipos.all()) await expect(enlace).toHaveAttribute("href", /^\/equipos\/[^/]+$/);
  // Los escudos también se tocan, pero no duplican el enlace para el teclado ni el lector de pantalla.
  const escudos = page.locator("main a:has(.tb-escudo)");
  await expect(escudos).toHaveCount(2);
  for (const escudo of await escudos.all()) {
    await expect(escudo).toHaveAttribute("tabindex", "-1");
    await expect(escudo).toHaveAttribute("aria-hidden", "true");
  }
  const competencia = page.locator(".tb-volanta a");
  await expect(competencia).toHaveAttribute("href", /^\/ligas\/[^/]+$/);
  await expect(page.locator(".tb-recuadro a[href^='/ligas/']")).toHaveCount(1);

  const nombre = (await equipos.first().textContent())!.trim();
  await equipos.first().click();
  await expect(page).toHaveURL(/\/equipos\//);
  await expect(page.getByRole("heading", { level: 1 })).toContainText(nombre, { ignoreCase: true });
  await page.goBack();
  await competencia.click();
  await expect(page).toHaveURL(/\/ligas\//);
});

test("equipo: sin sesión, un solo aviso para iniciar sesión en lugar de uno por partido", async ({ page }, info) => {
  await page.goto("/equipos/river");
  const filas = page.locator(".eq-fila");
  expect(await filas.count()).toBeGreaterThan(0);
  await expect(filas.getByRole("button")).toHaveCount(0);
  // El llamado único vive en el bloque "En tu calendario" (docs/33 D5)
  const aviso = page.getByRole("region", { name: "En tu calendario" });
  await expect(aviso.getByRole("link", { name: "Iniciá sesión", exact: true })).toHaveAttribute("href", "/login?next=%2Fequipos%2Friver");
  await expect(page.getByRole("button", { name: /Iniciá sesión/ })).toHaveCount(0);
  await info.attach("equipo-visitante", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
});

for (const conSesion of [false, true]) {
  test(`equipo: la cabecera usa todo el ancho y la liga es un enlace (${conSesion ? "con sesión" : "visitante"})`, async ({ page, isMobile }, info) => {
    test.skip(!isMobile, "La grilla de la cabecera es la vista móvil");
    if (conSesion) await login(page, info, "navigation");
    await page.goto("/equipos/river");
    await expect(page.locator(".eq-titulo .tb-volanta a")).toHaveAttribute("href", /^\/ligas\/[^/]+$/);
    const medidas = await page.evaluate(() => {
      const caja = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const cab = caja(".eq-cab");
      return {
        cabIzq: cab.left, cabDer: cab.right,
        comp: caja(".eq-competencias"),
        botones: [...document.querySelectorAll(".eq-acciones .tb-boton")].map((b) => { const r = b.getBoundingClientRect(); return { izq: r.left, der: r.right, top: r.top }; }),
      };
    });
    await info.attach("cabecera-equipo", { body: await page.locator(".eq-cab").screenshot(), contentType: "image/png" });
    expect(medidas.comp.left, "Las competencias no van en la columna del escudo").toBeLessThanOrEqual(medidas.cabIzq + 1);
    expect(medidas.comp.right, "Las competencias ocupan todo el ancho").toBeGreaterThanOrEqual(medidas.cabDer - 1);
    expect(medidas.botones.length).toBeGreaterThan(0);
    // Cada fila de botones llena el ancho: un botón solo ocupa toda la fila; dos la comparten.
    const filas = new Map<number, { izq: number; der: number }[]>();
    for (const boton of medidas.botones) filas.set(Math.round(boton.top), [...(filas.get(Math.round(boton.top)) ?? []), boton]);
    for (const fila of filas.values()) {
      expect(Math.min(...fila.map((b) => b.izq)), "La fila arranca en el borde").toBeLessThanOrEqual(medidas.cabIzq + 1);
      expect(Math.max(...fila.map((b) => b.der)), "La fila no deja medio ancho vacío").toBeGreaterThanOrEqual(medidas.cabDer - 1);
    }
  });
}

test("equipo: con sesión, cada partido mantiene su acción y no se pide login", async ({ page }, info) => {
  await login(page, info, "navigation");
  await page.goto("/equipos/river");
  const bloque = page.getByRole("region", { name: "En tu calendario" });
  await expect(bloque).toBeVisible();
  await expect(bloque.getByRole("link", { name: "Iniciá sesión", exact: true })).toHaveCount(0);
  const filas = page.locator(".eq-fila");
  await expect(filas.first().getByRole("button")).toHaveCount(1);
});

test("partido: la ficha es un h2 bajo el titular", async ({ page }) => {
  await page.goto("/partidos/superclasico");
  await expect(page.getByRole("heading", { level: 2, name: "Ficha del partido" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(0);
});

test("táctil: los enlaces de navegación miden al menos 44px de alto", async ({ page, isMobile }) => {
  test.skip(!isMobile, "La zona táctil ampliada aplica solo con puntero grueso");
  const casos: Array<[string, string]> = [
    ["/", "main a[href='/ayuda']"],
    ["/", ".tb-footer__enlace"],
    ["/partidos/superclasico", ".tb-volver"],
    ["/equipos/river", ".eq-mig a"],
  ];
  for (const [path, selector] of casos) {
    await page.goto(path);
    const enlaces = page.locator(selector);
    expect(await enlaces.count(), `${path} ${selector}`).toBeGreaterThan(0);
    for (const enlace of await enlaces.all()) {
      const alto = await enlace.evaluate((element) => element.getBoundingClientRect().height);
      expect(alto, `${path} ${selector}`).toBeGreaterThanOrEqual(44);
    }
  }
});

test("hoy: la tira de días usa texto de al menos 12px", async ({ page, isMobile }) => {
  test.skip(!isMobile, "La tira de días es la vista móvil de Hoy");
  await page.goto("/hoy");
  const dia = page.locator(".hm-dia").first();
  await expect(dia).toBeVisible();
  const tamanos = await page.locator(".hm-dia__sem, .hm-dia__cant").evaluateAll((elements) => elements.map((element) => parseFloat(getComputedStyle(element).fontSize)));
  expect(Math.min(...tamanos)).toBeGreaterThanOrEqual(12);
});

test("buscador: aparece en la primera pantalla, antes de los filtros", async ({ page }, info) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/equipos/buscar");
  const search = page.getByRole("searchbox", { name: "Buscar equipos" });
  await ready(page, search);
  await page.evaluate(() => window.scrollTo(0, 0));
  const caja = await search.boundingBox();
  await info.attach("buscador-375x667", { body: await page.screenshot(), contentType: "image/png" });
  expect(caja!.y + caja!.height, "El campo debe verse entero sin desplazar").toBeLessThanOrEqual(667);
  const antes = await search.evaluate((input) => {
    const chip = document.querySelector("button[aria-pressed]")!;
    return Boolean(input.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(antes, "El buscador va antes que los chips de competencias").toBe(true);
});

test("buscador: en móvil los chips ocupan una sola fila", async ({ page, isMobile }) => {
  test.skip(!isMobile, "La fila desplazable aplica en móvil");
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/equipos/buscar");
  await ready(page, page.getByRole("searchbox", { name: "Buscar equipos" }));
  const medidas = await page.evaluate(() => ({
    tops: [...document.querySelectorAll("button[aria-pressed]")].map((chip) => Math.round(chip.getBoundingClientRect().top)),
    content: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
  }));
  expect(medidas.tops.length).toBeGreaterThan(2);
  expect(new Set(medidas.tops).size, "Todos los chips en la misma fila").toBe(1);
  expect(medidas.content, "La fila se desplaza dentro de su caja, no la página").toBeLessThanOrEqual(medidas.viewport + 1);
});

test("buscador: la consulta y la liga se conservan en la URL", async ({ page }) => {
  await page.goto("/equipos/buscar");
  const search = page.getByRole("searchbox", { name: "Buscar equipos" });
  await ready(page, search);
  const chip = page.locator("button[aria-pressed]").nth(1);
  const nombreLiga = (await chip.textContent())!.trim();
  await chip.click();
  await search.fill("River");
  await expect(page).toHaveURL(/[?&]q=River(&|$)/);
  await expect(page).toHaveURL(/[?&]liga=[^&]+/);
  const resultados = await page.locator(".tb-meta").first().textContent();

  // Recargar conserva todo, sin agregar entradas al historial por cada letra.
  await page.reload();
  const tras = page.getByRole("searchbox", { name: "Buscar equipos" });
  await expect(tras).toHaveValue("River");
  await expect(page.getByRole("button", { name: nombreLiga, exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".tb-meta").first()).toHaveText(resultados!);

  // Ir a otra pantalla y volver con Atrás.
  await page.goto("/ligas");
  await page.goBack();
  await expect(page.getByRole("searchbox", { name: "Buscar equipos" })).toHaveValue("River");

  // Limpiar filtros también limpia la URL.
  await ready(page, page.getByRole("searchbox", { name: "Buscar equipos" }));
  await page.getByRole("button", { name: "Limpiar filtros" }).click();
  await expect(page).not.toHaveURL(/[?&](q|liga)=/);
});

test("buscador: el HTML del servidor trae la consulta y descarta ligas desconocidas", async ({ page, request }) => {
  const html = await (await request.get("/equipos/buscar?q=River")).text();
  expect(html).toMatch(/<input[^>]*value="River"/);
  await page.goto("/equipos/buscar?liga=no-existe");
  await ready(page, page.getByRole("searchbox", { name: "Buscar equipos" }));
  await expect(page.getByRole("button", { name: "Todas", exact: true })).toHaveAttribute("aria-pressed", "true");
});

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
