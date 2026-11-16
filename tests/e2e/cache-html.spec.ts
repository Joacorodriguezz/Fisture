import { test, expect } from "@playwright/test";

// docs/34: el HTML anónimo de equipos, ligas y partidos va a la Cache API; con sesión nunca.
// Las rutas son distintas por test para no depender del orden ni de las copias de otros tests.
// El servidor es el mismo para escritorio y móvil: la URL del primer test cambia por proyecto y reintento.

test("el segundo GET anónimo a un equipo sale de la caché y conserva los headers de seguridad", async ({ request }) => {
  const primera = await request.get(ruta);
  expect(primera.status()).toBe(200);
  expect(primera.headers()["x-fisture-cache"]).toBe("MISS");
  expect(primera.headers()["cache-control"]).toBe("public, max-age=0, must-revalidate");

  // El put va en waitUntil: se reintenta un momento hasta que la copia esté guardada
  await expect
    .poll(async () => (await request.get(ruta)).headers()["x-fisture-cache"], { timeout: 10_000 })
    .toBe("HIT");

  const segunda = await request.get(ruta);
  const headers = segunda.headers();
  expect(headers["x-fisture-cache"]).toBe("HIT");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["set-cookie"]).toBeUndefined();
  expect(await segunda.text()).toBe(await primera.text());
});

test("con cookie session no se lee ni se escribe la caché", async ({ request }) => {
  // Se calienta la caché anónima de la página
  await request.get("/ligas/e2e-league");
  await expect
    .poll(async () => (await request.get("/ligas/e2e-league")).headers()["x-fisture-cache"], { timeout: 10_000 })
    .toBe("HIT");

  const conSesion = await request.get("/ligas/e2e-league", { headers: { Cookie: "session=cookie-invalida" } });
  expect(conSesion.status()).toBe(200);
  expect(conSesion.headers()["x-fisture-cache"]).toBeUndefined();
});

test("las 404 y los parámetros no permitidos no pasan por la caché", async ({ request }) => {
  const noExiste = await request.get("/partidos/no-existe");
  expect(noExiste.status()).toBe(404);
  expect(noExiste.headers()["x-fisture-cache"]).toBeUndefined();

  const conQuery = await request.get("/partidos/superclasico?x=1");
  expect(conQuery.headers()["x-fisture-cache"]).toBeUndefined();
});
