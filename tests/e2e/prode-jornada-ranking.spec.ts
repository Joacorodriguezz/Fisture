import { expect, test } from "@playwright/test";

test("la jornada usa la fecha argentina y guardar actualiza el ranking de la fase visible", async ({ page }, info) => {
  // A las 02 UTC del 20 todavía es 19 en Argentina. El partido de las 03 UTC ya corresponde al día siguiente.
  await page.clock.setFixedTime(new Date("2026-11-20T02:00:00Z"));
  await page.context().addCookies([{ name: "session", value: `e2e-${info.project.name}-prode-${info.retry}`, url: "http://127.0.0.1:4322" }]);
  await page.context().route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());

  const cruce = (id: string, fecha: string, hora: string, cierre: string, estado: string) => ({
    id, cierre, estado, faseEtiqueta: "Final", horario: { fecha, hora },
    local: { nombre: id }, visitante: { nombre: "Visitante" }, pronostico: null, resultado: null,
  });
  const partidos = [
    cruce("Cerrado hoy", "Jue 19/11", "18:00", "2026-11-19T21:00:00Z", "cerrado"),
    cruce("Abierto hoy", "Jue 19/11", "23:30", "2026-11-20T02:30:00Z", "abierto"),
    cruce("Mañana", "Vie 20/11", "00:00", "2026-11-20T03:00:00Z", "abierto"),
  ];
  let guardado = false;
  await page.route("**/api/prode/pronosticos", (route) => {
    if (route.request().method() === "PUT") {
      expect(route.request().postDataJSON()).toEqual({ matchId: "Abierto hoy", homeGoals: 2, awayGoals: 1 });
      guardado = true;
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { partidos } });
  });
  await page.route("**/api/prode/ranking*", (route) => {
    const fase = new URL(route.request().url()).searchParams.get("fase");
    const filas = fase === "final" && guardado ? [{ posicion: 1, nombre: "Ada", puntos: 0, exactos: 0, aciertos: 0, esVos: true }] : [];
    return route.fulfill({ json: { filas, total: filas.length, yo: filas[0] ?? null } });
  });

  await page.goto("/prode");
  const hoy = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Hoy/, level: 3 }) }).last();
  await expect(hoy.getByRole("form")).toHaveCount(2);
  await expect(hoy.getByRole("form").first()).toHaveAccessibleName("Abierto hoy vs Visitante");
  const proxima = page.locator("section").filter({ has: page.getByRole("heading", { name: /^Próxima fecha/, level: 3 }) }).last();
  await expect(proxima.getByRole("form")).toHaveAccessibleName("Mañana vs Visitante");

  await page.getByRole("link", { name: "Por fase" }).click();
  const selector = page.getByLabel("Fase", { exact: true });
  await expect(page).toHaveURL(/#ranking-fase$/);
  await selector.selectOption("final");
  await expect(page.getByText("Todavía no hay posiciones para mostrar.")).toBeVisible();

  const partido = hoy.getByRole("form").first();
  await partido.getByRole("textbox", { name: "Goles de Abierto hoy" }).fill("2");
  await partido.getByRole("textbox", { name: "Goles de Visitante" }).fill("1");
  await partido.getByRole("button", { name: "Guardar" }).click();
  await expect(page.getByRole("cell", { name: "Ada (vos)" })).toBeVisible();
  await expect(selector).toHaveValue("final");

  await page.getByRole("link", { name: "Ranking general" }).click();
  await expect(page).toHaveURL(/#posiciones$/);
  await expect(selector).toHaveValue("");
  await expect(page.getByText("Todavía no hay posiciones para mostrar.")).toBeVisible();
});
