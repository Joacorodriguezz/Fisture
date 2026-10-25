import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

// Solo GET sin credenciales ni mutaciones; también sirve contra un ambiente local explícito.
export async function runSmoke(baseUrl, { fetchImpl = fetch, attempts = 4, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const base = new URL(baseUrl);
  assert(["https:", "http:"].includes(base.protocol), "PUBLIC_APP_URL debe ser HTTP(S)");
  const checks = [
    ...["/", "/login", "/privacidad", "/terminos"].map((path) => ({ path, verify: async (response) => {
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /text\/html/);
      assert.match(await response.text(), /FISTURE|Fisture/);
    } })),
    { path: "/api/health", verify: async (response) => {
      assert.equal(response.status, 200, "health debe responder 200");
      const health = await response.json();
      assert.equal(health.checks?.db, "ok");
      assert.equal(health.checks?.kv, "ok");
      assert(["ok", "degraded"].includes(health.status), "salud inválida");
      assert(["ok", "degraded"].includes(health.checks?.sync), "sync fallido");
    } },
    { path: "/api/admin/status", verify: async (response) => { assert.equal(response.status, 401); } },
  ];
  for (const { path, verify } of checks) {
    let failure;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetchImpl(new URL(path, base), { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "Cache-Control": "no-cache" } });
        await verify(response);
        failure = undefined;
        break;
      } catch (error) {
        failure = error;
        if (attempt < attempts) await wait(3000);
      }
    }
    if (failure) throw new Error(`Smoke falló en ${path}: ${failure.message}`, { cause: failure });
    console.log(`PASS ${path}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.PUBLIC_APP_URL) throw new Error("Falta PUBLIC_APP_URL; no se asume una URL de producción");
  await runSmoke(process.env.PUBLIC_APP_URL);
}
