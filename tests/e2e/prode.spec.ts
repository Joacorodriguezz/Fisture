import { test, expect } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.route(/https?:\/\//, (route) => new URL(route.request().url()).hostname === "127.0.0.1" ? route.continue() : route.abort());
});

test("prode: sin sesión redirige al login y con sesión se ve la página", async ({ page }, info) => {
  for (const [ruta, next] of [["/prode", "%2Fprode"], ["/prode/grupos", "%2Fprode%2Fgrupos"]]) {
    await page.goto(ruta);
    await expect(page).toHaveURL(new RegExp(`/login\\?next=${next}$`));
  }

  await page.context().addCookies([{ name: "session", value: `e2e-${info.project.name}-prode-${info.retry}`, url: "http://127.0.0.1:4322", httpOnly: true }]);
  await page.goto("/prode");
  await expect(page.getByRole("heading", { level: 1, name: "TUS PRONÓSTICOS" })).toBeVisible();
  // Con o sin partidos cargados en la base de pruebas, la isla sale del estado de carga
  await expect(page.getByText("Cargando partidos…")).toHaveCount(0);

  await page.goto("/prode/grupos");
  await expect(page.getByRole("heading", { level: 1, name: "GRUPOS" })).toBeVisible();
  await expect(page.getByLabel("Nuevo grupo")).toBeVisible();
});
