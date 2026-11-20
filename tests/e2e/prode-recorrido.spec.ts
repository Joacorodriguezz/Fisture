// Recorrido del prode con datos sembrados en el escenario `prode` de scripts/e2e-server.mjs (docs/38).
// Cruces: prode-abierto (en 30 días), prode-cerrado (empezó hace 1 h) y prode-jugado (terminó 2-1, con el
// pronóstico 2-1 del dueño: 3 puntos). Dueño: `<proyecto>-prode-<retry>`; invitado: `<proyecto>-prode-invitado-<retry>`.
import { test, expect, type Page, type TestInfo } from "@playwright/test";

const ORIGEN = "http://127.0.0.1:4322";

test.beforeEach(async ({ context }) => {
  await context.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});

const idDueno = (info: TestInfo) => `${info.project.name}-prode-${info.retry}`;
const idInvitado = (info: TestInfo) => `${info.project.name}-prode-invitado-${info.retry}`;

async function conSesion(page: Page, id: string) {
  await page.context().addCookies([{ name: "session", value: `e2e-${id}`, url: ORIGEN, httpOnly: true }]);
}

async function sinScrollHorizontal(page: Page) {
  const medidas = await page.evaluate(() => ({ ancho: document.documentElement.scrollWidth, ventana: window.innerWidth }));
  expect(medidas.ancho).toBeLessThanOrEqual(medidas.ventana);
}

test("prode: guarda, edita y persiste el pronóstico de un partido abierto", async ({ page }, info) => {
  await conSesion(page, idDueno(info));
  await page.goto("/prode");
  const local = page.locator("#prode-prode-abierto-l");
  const visitante = page.locator("#prode-prode-abierto-v");
  await expect(local).toBeEnabled();

  await local.fill("1");
  await visitante.fill("0");
  await page.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByText("Pronóstico guardado.")).toBeVisible();

  await page.reload();
  await expect(local).toHaveValue("1");
  await expect(visitante).toHaveValue("0");

  // Editar: el botón pasa a "Cambiar" y el nuevo marcador también persiste
  await local.fill("3");
  await page.getByRole("button", { name: "Cambiar" }).click();
  await expect(page.getByText("Pronóstico guardado.")).toBeVisible();
  await page.reload();
  await expect(local).toHaveValue("3");
  await expect(visitante).toHaveValue("0");
});

test("prode: el partido cerrado no se edita y el servidor lo rechaza", async ({ page }, info) => {
  await conSesion(page, idDueno(info));
  await page.goto("/prode");
  await expect(page.locator("#prode-prode-abierto-l")).toBeEnabled();
  await expect(page.locator("#prode-prode-cerrado-l")).toBeDisabled();
  await expect(page.locator("#prode-prode-cerrado-v")).toBeDisabled();
  await expect(page.getByText("Cerró el pronóstico. No cargaste uno.")).toBeVisible();

  const res = await page.request.put("/api/prode/pronosticos", {
    headers: { Origin: ORIGEN },
    data: { matchId: "prode-cerrado", homeGoals: 1, awayGoals: 1 },
  });
  expect(res.status()).toBe(409);
  expect(await res.json()).toMatchObject({ error: "pronostico_cerrado" });

  // El partido terminado muestra el resultado y los puntos del pronóstico previo
  await expect(page.getByText("Resultado: 2 - 1.")).toBeVisible();
  await expect(page.getByText("Sumaste 3 puntos (resultado exacto).")).toBeVisible();
  await expect(page.getByText("Tus puntos: 3")).toBeVisible();
});

test("prode: crea un grupo, muestra la invitación y otro usuario se une con el enlace", async ({ page, browser }, info) => {
  await conSesion(page, idDueno(info));
  const hidratacion = Promise.withResolvers<void>();
  await page.route("**/_astro/ProdeGrupos.*.js", async (route) => {
    await hidratacion.promise;
    await route.continue();
  });
  const nombreGrupo = page.getByLabel("Nuevo grupo");
  const crearGrupo = page.getByRole("button", { name: "Crear grupo" });
  try {
    const modulo = page.waitForRequest("**/_astro/ProdeGrupos.*.js");
    await page.goto("/prode/grupos", { waitUntil: "domcontentloaded" });
    await modulo;
    await expect(nombreGrupo).toBeDisabled();
    await expect(crearGrupo).toBeDisabled();
  } finally {
    hidratacion.resolve();
  }
  await nombreGrupo.fill(`Amigos ${info.project.name}`);
  await crearGrupo.click();
  await expect(page).toHaveURL(/\/prode\/grupos\/[^/]+$/);

  const enlace = await page.locator("#grupo-enlace").inputValue();
  expect(enlace).toMatch(new RegExp(`^${ORIGEN}/prode/unirse/[A-Za-z0-9_-]{22}$`));
  await expect(page.getByRole("heading", { name: "Integrantes (1)" })).toBeVisible();

  const contexto = await browser.newContext({ baseURL: ORIGEN });
  try {
    await contexto.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
    await contexto.addCookies([{ name: "session", value: `e2e-${idInvitado(info)}`, url: ORIGEN, httpOnly: true }]);
    const invitado = await contexto.newPage();
    await invitado.goto(enlace);
    await expect(invitado).toHaveURL(/\/prode\/grupos\/[^/]+$/);
    await expect(invitado.getByRole("heading", { name: "Integrantes (2)" })).toBeVisible();
    await expect(invitado.getByRole("listitem").filter({ hasText: `Invitado ${idInvitado(info)} (vos)` })).toBeVisible();
    // El invitado no ve el código: solo el dueño comparte la invitación
    await expect(invitado.locator("#grupo-enlace")).toHaveCount(0);
  } finally {
    await contexto.close();
  }

  // El dueño ve al integrante nuevo
  await page.reload();
  await expect(page.getByRole("heading", { name: "Integrantes (2)" })).toBeVisible();
});

test("prode: el ranking general y el del grupo muestran nombre, posición y puntos", async ({ page }, info) => {
  const nombre = `Dueño ${idDueno(info)}`;
  await conSesion(page, idDueno(info));

  await page.goto("/prode");
  const fila = page.getByRole("row", { name: new RegExp(`${nombre} \\(vos\\)`) });
  await expect(fila).toBeVisible();
  // Todos los dueños sembrados empatan con un exacto (3 puntos): comparten la posición 1
  await expect(fila.getByRole("cell")).toHaveText(["1", `${nombre} (vos)`, "1", "1", "3"]);

  await page.goto(`/prode/grupos/grupo-${idDueno(info)}`);
  await expect(page.getByRole("heading", { name: "Integrantes (1)" })).toBeVisible();
  const filaGrupo = page.getByRole("row", { name: new RegExp(`${nombre} \\(vos\\)`) });
  await expect(filaGrupo).toBeVisible();
  await expect(filaGrupo.getByRole("cell")).toHaveText(["1", `${nombre} (vos)`, "1", "1", "3"]);
});

test("prode: sin scroll horizontal en /prode y /prode/grupos", async ({ page }, info) => {
  await conSesion(page, idDueno(info));
  await page.goto("/prode");
  await expect(page.getByText("Cargando partidos…")).toHaveCount(0);
  await expect(page.getByRole("row", { name: /\(vos\)/ })).toBeVisible();
  await sinScrollHorizontal(page);

  await page.goto("/prode/grupos");
  await expect(page.getByText("Cargando grupos…")).toHaveCount(0);
  await sinScrollHorizontal(page);
});
