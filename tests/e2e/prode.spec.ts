// Flujos principales del prode (docs/37 §6): sin sesión, crear, unirse por link, jugar y administrar.
// Datos en scripts/e2e-server.mjs: grupo «Los del Cinco» (código PRDE2345) en una competencia propia,
// grupo «Sumate al prode» (SUMATE23) y un grupo propio por persona de administración.
import { test, expect, type Page, type TestInfo, type Locator } from "@playwright/test";

const usuario = (info: TestInfo, scenario: string) => `${info.project.name}-${scenario}-${info.retry}`;

async function login(page: Page, info: TestInfo, scenario: string) {
  await page.context().addCookies([{ name: "session", value: `e2e-${usuario(info, scenario)}`, url: "http://127.0.0.1:4322", httpOnly: true }]);
}

async function ready(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  await expect(page.locator("astro-island[ssr]").filter({ has: control })).toHaveCount(0);
}

test.beforeEach(async ({ context }) => {
  await context.route(/https?:\/\//, (route) => (new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort()));
});

test("sin sesión: presenta el juego, valida el código y la invitación pide login y vuelve", async ({ page }) => {
  await page.goto("/prode");
  await expect(page.getByRole("heading", { level: 1, name: "Prode" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Ingresá para jugar" })).toHaveAttribute("href", "/login?next=%2Fprode");
  await expect(page.getByRole("list", { name: "Cómo se suman puntos" })).toContainText("Resultado exacto");

  // Un código mal escrito vuelve con el error; uno bien escrito (en minúsculas y con espacio) va a la invitación
  const codigo = page.getByLabel("Código del grupo");
  await codigo.fill("abc");
  await page.getByRole("button", { name: "Ver el grupo" }).click();
  await expect(page).toHaveURL(/\/prode\?error=codigo$/);
  await expect(page.getByText("Ese código no es válido")).toBeVisible();
  await page.getByLabel("Código del grupo").fill("sumate 23");
  await page.getByRole("button", { name: "Ver el grupo" }).click();
  await expect(page).toHaveURL(/\/prode\/unirse\/SUMATE23$/);
  await expect(page.getByRole("heading", { level: 1, name: "Sumate al prode" })).toBeVisible();
  await expect(page.getByText("organiza Ana G.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ingresá para unirte" })).toHaveAttribute("href", "/login?next=%2Fprode%2Funirse%2FSUMATE23");

  const inexistente = await page.goto("/prode/unirse/ZZZZZZZZ");
  expect(inexistente?.status()).toBe(404);
  await expect(page.getByRole("heading", { level: 1, name: "Ese código no existe" })).toBeVisible();

  // Las páginas de grupo piden login y vuelven al grupo
  await page.goto("/prode/grupo-e2e?tab=tabla");
  await expect(page).toHaveURL(/\/login\?next=%2Fprode%2Fgrupo-e2e%3Ftab%3Dtabla$/);
});

test("navegación: Prode está en la cabecera y la barra inferior sigue con 5 destinos", async ({ page, isMobile }) => {
  await page.goto("/ligas");
  const prode = isMobile
    ? page.getByRole("banner").getByRole("link", { name: "Prode", exact: true })
    : page.getByRole("navigation", { name: "Secciones" }).first().getByRole("link", { name: "Prode", exact: true });
  await expect(prode).toBeVisible();
  const caja = (await prode.boundingBox())!;
  expect(caja.height).toBeGreaterThanOrEqual(44);
  if (isMobile) await expect(page.getByRole("navigation", { name: "Secciones", exact: true }).last().getByRole("link")).toHaveCount(5);
  await prode.click();
  await expect(page).toHaveURL(/\/prode$/);
  await expect(prode).toHaveAttribute("aria-current", "page");
});

test("crea un grupo, ve la invitación y carga un pronóstico que persiste", async ({ page }, info) => {
  await login(page, info, "prode-crear");
  await page.goto("/prode");
  await expect(page.getByText("Todavía no estás en ningún grupo.")).toBeVisible();

  const nombre = page.getByLabel("Nombre del grupo");
  await ready(page, nombre);
  // Un nombre corto se avisa sin ir al servidor
  await nombre.fill("ab");
  await page.getByRole("button", { name: "Crear grupo" }).click();
  await expect(page.getByText("El nombre tiene que tener entre 3 y 40 caracteres.")).toBeVisible();
  await nombre.fill("Los del Asado");
  await page.getByLabel("Competencia").selectOption({ label: "Liga neutral" });
  await page.getByRole("button", { name: "Crear grupo" }).click();

  await expect(page).toHaveURL(/\/prode\/[0-9a-f-]{36}\?tab=grupo&aviso=creado$/);
  await expect(page.getByRole("status").filter({ hasText: "Grupo creado" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: "Los del Asado" })).toBeVisible();
  await expect(page.locator(".pr-codigo")).toHaveText(/^[A-Z2-9]{4} [A-Z2-9]{4}$/);
  await expect(page.getByText("Organiza")).toBeVisible();

  await page.getByRole("link", { name: "Pronósticos" }).click();
  const local = page.getByRole("textbox", { name: "Goles de Equipo neutral local" });
  const visitante = page.getByRole("textbox", { name: "Goles de Equipo neutral visitante" });
  await ready(page, local);
  const sumarLocal = page.getByRole("button", { name: "Sumar un gol a Equipo neutral local" });
  await sumarLocal.click();
  await sumarLocal.click();
  // Al cargar un lado, el otro arranca en 0
  await expect(visitante).toHaveValue("0");
  await page.getByRole("button", { name: "Sumar un gol a Equipo neutral visitante" }).click();
  await expect(local).toHaveValue("2");
  await expect(visitante).toHaveValue("1");
  await expect(page.getByText("1 cambio sin guardar")).toBeVisible();
  await page.getByRole("button", { name: "Guardar pronósticos" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Guardamos 1 pronóstico." })).toBeVisible();

  await page.reload();
  await ready(page, local);
  await expect(local).toHaveValue("2");
  await expect(visitante).toHaveValue("1");
  await expect(page.getByText("✓ Guardado")).toBeVisible();
  await expect(page.getByText("Todo guardado")).toBeVisible();

  // El grupo aparece en /prode
  await page.goto("/prode");
  await expect(page.getByRole("link", { name: /Los del Asado/ })).toBeVisible();
});

test("se une por el link de invitación y aparece en la tabla", async ({ page }, info) => {
  await login(page, info, "prode-unirse");
  await page.goto("/prode/unirse/SUMATE23");
  const unirme = page.getByRole("button", { name: "Unirme al prode" });
  await ready(page, unirme);
  await unirme.click();
  await expect(page).toHaveURL(/\/prode\/grupo-unirse\?aviso=bienvenida$/);
  await expect(page.getByText("Ya estás en el grupo.")).toBeVisible();
  await page.getByRole("link", { name: "Tabla" }).click();
  await expect(page.getByRole("row").filter({ hasText: "Vos" })).toHaveCount(1);
  // Volver al link ya no ofrece unirse
  await page.goto("/prode/unirse/SUMATE23");
  await expect(page.getByText("Ya sos parte de este grupo.")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ir al grupo" })).toHaveAttribute("href", "/prode/grupo-unirse");
});

test("tabla con empates, historial con lo del grupo y pronósticos que se bloquean al empezar", async ({ page, isMobile }, info) => {
  await login(page, info, "prode-jugar");
  await page.goto("/prode/grupo-e2e?tab=tabla");
  const filas = page.locator("table.tb-posiciones tbody tr");
  // Ana y Beto empatan en puntos, exactos y aciertos: comparten el 1.º
  await expect(filas.nth(0)).toContainText("Ana G.");
  await expect(filas.nth(0).locator("td").first()).toHaveText("1");
  await expect(filas.nth(1)).toContainText("Roberto D.");
  await expect(filas.nth(1).locator("td").first()).toHaveText("1");
  await expect(filas.filter({ hasText: "Vos" })).toHaveCount(1);

  await page.getByRole("link", { name: "Historial" }).click();
  const partidos = page.locator(".pr-hist > li");
  await expect(partidos).toHaveCount(3);
  const racing = partidos.filter({ hasText: "Racing Club" });
  await expect(racing).toContainText("Tu pronóstico: 1 – 1");
  await expect(racing).toContainText("0 puntos");
  await racing.getByText(/Lo que puso el grupo/).click();
  await expect(racing.getByRole("listitem").filter({ hasText: "Ana G." })).toContainText("2 – 1 · 3 pts");
  await expect(partidos.filter({ hasText: "Huracán" })).toContainText("Sin resultado todavía");
  // El 3-0 de Beto es de un partido que no empezó: nunca está en el HTML
  expect(await page.content()).not.toContain("3 – 0");

  // Pronósticos: se guarda uno y, al llegar la hora de inicio con la página abierta, la fila se bloquea
  await page.clock.install();
  await page.getByRole("link", { name: "Pronósticos" }).click();
  const racingLocal = page.getByRole("textbox", { name: "Goles de Racing Club" });
  await ready(page, racingLocal);
  await racingLocal.fill("3");
  await expect(page.getByRole("textbox", { name: "Goles de Independiente" })).toHaveValue("0");
  if (isMobile) {
    // Con cambios, la barra de guardar queda a la vista, sobre la barra inferior
    const barra = (await page.locator(".pr-barra-guardar").boundingBox())!;
    const navegacion = (await page.locator(".tb-barra-inferior").boundingBox())!;
    expect(barra.y + barra.height).toBeLessThanOrEqual(navegacion.y + 1);
    expect(barra.y).toBeLessThan(page.viewportSize()!.height);
  }
  await page.getByRole("button", { name: "Guardar pronósticos" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Guardamos 1 pronóstico." })).toBeVisible();

  await page.clock.fastForward(22 * 86_400_000);
  await expect(racingLocal).toBeDisabled();
  await expect(page.getByText("Cerrado: ya empezó").first()).toBeVisible();
});

test("administración: cambiar el código, sacar a un miembro y borrar el grupo", async ({ page }, info) => {
  await login(page, info, "prode-admin");
  const grupo = `admin-${usuario(info, "prode-admin")}`;
  await page.goto(`/prode/${grupo}?tab=grupo`);
  const codigo = page.locator(".pr-codigo");
  const anterior = await codigo.textContent();
  expect(anterior).toMatch(/^ADMN /);

  const cambiar = page.getByRole("button", { name: "Cambiar el código" });
  await ready(page, cambiar);
  await cambiar.click();
  await page.getByRole("group", { name: "Confirmar: cambiar el código" }).getByRole("button", { name: "Sí, cambiar" }).click();
  await expect(page.getByText("Código nuevo.")).toBeVisible();
  await expect(codigo).not.toHaveText(anterior!);

  const sacar = page.getByRole("button", { name: "Sacar a Martín S. del grupo" });
  await ready(page, sacar);
  await sacar.click();
  // La opción segura recibe el foco
  await expect(page.getByRole("button", { name: "Cancelar" })).toBeFocused();
  await page.getByRole("button", { name: "Sí, sacar" }).click();
  await expect(page.getByText("Martín S. ya no está en el grupo.")).toBeVisible();
  await expect(page.getByRole("heading", { name: "1 jugador" })).toBeVisible();

  await page.getByRole("button", { name: "Borrar el grupo" }).click();
  await page.getByRole("button", { name: "Sí, borrar el grupo" }).click();
  await expect(page).toHaveURL(/\/prode\?aviso=borrado$/);
  await expect(page.getByText("Borraste el grupo.")).toBeVisible();
  expect((await page.goto(`/prode/${grupo}`))?.status()).toBe(404);
});
