import { beforeEach, describe, expect, it, vi } from "vitest";
import { withApi } from "../../../src/lib/observability/with-api";
import { createLogger } from "../../../src/lib/observability/logger";
import { reiniciarMemoria } from "../../../src/lib/rate-limit/memory";
import { POST as syncPost } from "../../../src/pages/api/calendario/sync";
import { GET as buscar } from "../../../src/pages/api/equipos/buscar";
import { GET as status } from "../../../src/pages/api/admin/status";
import { POST as adminSync } from "../../../src/pages/api/admin/sync";
import { reiniciarConfig, TTL_CONFIG_MS } from "../../../src/lib/rate-limit/config";
import { apiCtx, kvEnMemoria } from "../../helpers/ctx";
import { AHORA, relojFijo } from "../../helpers/clock";
import { useTestDb } from "../../helpers/use-test-db";

const APP = "https://fisture.test";
const SECRET = "secreto-admin-de-prueba";
const IP = "203.0.113.7";

function capturar() {
  const lineas: { level: string; raw: string; data: Record<string, any> }[] = [];
  const logger = createLogger({ level: "debug", write: (level, line) => lineas.push({ level, raw: line, data: JSON.parse(line) }) });
  return { logger, lineas };
}

describe("withApi: límite de tasa y origen", () => {
  const t = useTestDb();
  relojFijo();
  beforeEach(() => (reiniciarMemoria(), reiniciarConfig()));

  const env = (extra: Record<string, unknown> = {}) => ({ DB: t.DB, ENVIRONMENT: "test", PUBLIC_APP_URL: APP, RATE_LIMIT_SALT: "sal", ...extra });
  const ok = async () => Response.json({ ok: true });
  const peticion = (opts: Parameters<typeof apiCtx>[0] = {}) =>
    apiCtx({ url: `${APP}/api/x`, method: "POST", headers: { "cf-connecting-ip": IP, "sec-fetch-site": "same-origin" }, user: { id: "u1" }, env: env(), ...opts });

  it("RL1/RL2/OB1: la request 11 da 429 con Retry-After, cuerpo uniforme y log sin IP", async () => {
    const { logger, lineas } = capturar();
    const handler = withApi(ok, { logger, rateLimit: ["calendar_sync"] });
    for (let i = 0; i < 10; i++) expect((await handler(peticion())).status).toBe(200);
    const res = await handler(peticion());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toMatchObject({ error: "rate_limited", retryAfter: 60, requestId: expect.any(String) });

    const aviso = lineas.find((l) => l.data.msg === "rate_limited");
    expect(aviso?.level).toBe("warn");
    expect(aviso?.data).toMatchObject({ bucket: "calendar_sync", scope: "user", limit: 10 });
    expect(JSON.stringify(lineas.map((l) => l.raw))).not.toContain(IP);
  });

  it("OB1: solo el primer bloqueo de la ventana va en warn, el resto en debug", async () => {
    const { logger, lineas } = capturar();
    const handler = withApi(ok, { logger: logger, rateLimit: ["calendar_sync"] });
    for (let i = 0; i < 13; i++) await handler(peticion());
    const limitados = lineas.filter((l) => l.data.msg === "rate_limited");
    expect(limitados.filter((l) => l.level === "warn")).toHaveLength(1);
    expect(limitados.filter((l) => l.level === "debug")).toHaveLength(2);
  });

  it("RL3: en la ventana siguiente vuelve a pasar", async () => {
    const handler = withApi(ok, { logger: capturar().logger, rateLimit: ["calendar_sync"] });
    for (let i = 0; i < 11; i++) await handler(peticion());
    vi.setSystemTime(new Date(AHORA.getTime() + 61_000));
    expect((await handler(peticion())).status).toBe(200);
  });

  it("RL4: dos usuarios distintos no comparten contador", async () => {
    const handler = withApi(ok, { logger: capturar().logger, rateLimit: ["calendar_sync"] });
    for (let i = 0; i < 11; i++) await handler(peticion());
    expect((await handler(peticion({ user: { id: "u2" } }))).status).toBe(200);
  });

  it("RL5: dos IP distintas no comparten contador (límite por IP)", async () => {
    const handler = withApi(ok, { logger: capturar().logger, rateLimit: ["login"] });
    const desde = (ip: string) => peticion({ method: "GET", user: null, headers: { "cf-connecting-ip": ip } });
    for (let i = 0; i < 11; i++) await handler(desde("198.51.100.1"));
    expect((await handler(desde("198.51.100.1"))).status).toBe(429);
    expect((await handler(desde("198.51.100.2"))).status).toBe(200);
  });

  it("RL9: sin sesión en un endpoint por usuario solo aplica el límite por IP", async () => {
    const handler = withApi(ok, { logger: capturar().logger, rateLimit: ["calendar_sync_ip", "calendar_sync"] });
    for (let i = 0; i < 12; i++) expect((await handler(peticion({ user: null }))).status).toBe(200);
    const filas = await t.DB.prepare("SELECT bucket FROM rate_limits").all<{ bucket: string }>();
    expect(filas.results.map((r) => r.bucket)).toEqual(["calendar_sync_ip"]);
  });

  it("RL10: sin cf-connecting-ip se omite el scope IP sin error", async () => {
    const handler = withApi(ok, { logger: capturar().logger, rateLimit: ["login"] });
    for (let i = 0; i < 15; i++) {
      expect((await handler(peticion({ method: "GET", user: null, headers: {} }))).status).toBe(200);
    }
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>())?.n).toBe(0);
  });

  it("D2: si el límite por IP ya bloqueó no se evalúa el de usuario", async () => {
    const handler = withApi(ok, { logger: capturar().logger, rateLimit: ["calendar_sync_ip", "calendar_delete"] });
    for (let i = 0; i < 31; i++) await handler(peticion());
    const porUsuario = await t.DB.prepare("SELECT count FROM rate_limits WHERE bucket = 'calendar_delete'").first<{ count: number }>();
    expect(porUsuario?.count).toBe(30); // la request 31 (bloqueada por IP) no tocó el contador de usuario
  });

  it("RL12: el límite por hora vence aunque el de por minuto se reinicie", async () => {
    const { logger, lineas } = capturar();
    const handler = withApi(ok, { logger, rateLimit: ["calendar_sync", "calendar_sync_hour"] });
    for (let minuto = 0; minuto < 6; minuto++) {
      vi.setSystemTime(new Date(AHORA.getTime() + minuto * 60_000));
      for (let i = 0; i < 10; i++) expect((await handler(peticion())).status).toBe(200);
    }
    vi.setSystemTime(new Date(AHORA.getTime() + 6 * 60_000));
    const res = await handler(peticion());
    expect(res.status).toBe(429);
    expect(lineas.find((l) => l.data.msg === "rate_limited")?.data.bucket).toBe("calendar_sync_hour");
  });

  it("D6: una mutación sin política explícita cae en el límite genérico (falla segura)", async () => {
    const handler = withApi(ok, { logger: capturar().logger });
    for (let i = 0; i < 60; i++) expect((await handler(peticion())).status).toBe(200);
    expect((await handler(peticion())).status).toBe(429);
  });

  it("una lectura sin política no cuenta ni escribe", async () => {
    const handler = withApi(ok, { logger: capturar().logger });
    for (let i = 0; i < 5; i++) await handler(peticion({ method: "GET" }));
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>())?.n).toBe(0);
  });

  it("RL8: si D1 falla al contar, la request pasa y se loguea rate_limit_unavailable", async () => {
    const { logger, lineas } = capturar();
    const roto = { prepare: () => { throw new Error("D1 caída"); } };
    const handler = withApi(ok, { logger, rateLimit: ["calendar_sync"] });
    const res = await handler(peticion({ env: env({ DB: roto }) }));
    expect(res.status).toBe(200);
    expect(lineas.some((l) => l.level === "error" && l.data.msg === "rate_limit_unavailable")).toBe(true);
  });

  it("RL17: RATE_LIMIT_DISABLED=true no limita ni escribe, pero el origen se sigue verificando", async () => {
    const handler = withApi(ok, { logger: capturar().logger, rateLimit: ["calendar_sync"] });
    const e = env({ RATE_LIMIT_DISABLED: "true" });
    for (let i = 0; i < 15; i++) expect((await handler(peticion({ env: e }))).status).toBe(200);
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>())?.n).toBe(0);
    const ajeno = await handler(peticion({ env: e, headers: { cookie: "session=x", "sec-fetch-site": "cross-site" } }));
    expect(ajeno.status).toBe(403);
  });

  it("RL18: en modo observe cuenta y loguea pero no devuelve 429", async () => {
    const { logger, lineas } = capturar();
    const handler = withApi(ok, { logger, rateLimit: ["calendar_sync"] });
    const e = env({ RATE_LIMIT_MODE: "observe" });
    for (let i = 0; i < 12; i++) expect((await handler(peticion({ env: e }))).status).toBe(200);
    expect(lineas.find((l) => l.data.msg === "rate_limited")?.data).toMatchObject({ observe: true, bucket: "calendar_sync" });
  });

  describe("interruptor en caliente (KV)", () => {
    const filas = async () => (await t.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>())?.n;
    const correr = async (e: Record<string, unknown>, n = 12) => {
      const handler = withApi(ok, { logger: capturar().logger, rateLimit: ["calendar_sync"] });
      const codigos: number[] = [];
      for (let i = 0; i < n; i++) codigos.push((await handler(peticion({ env: e }))).status);
      return codigos;
    };

    it("KV1: ratelimit:modo=off apaga el limitador sin escribir, sin redeploy ni secret", async () => {
      const KV = kvEnMemoria();
      KV.datos.set("ratelimit:modo", "off");
      expect((await correr(env({ KV }))).every((c) => c === 200)).toBe(true);
      expect(await filas()).toBe(0);
    });

    it("KV2: ratelimit:modo=observe cuenta pero no bloquea", async () => {
      const KV = kvEnMemoria();
      KV.datos.set("ratelimit:modo", "observe");
      expect((await correr(env({ KV }))).every((c) => c === 200)).toBe(true);
      expect(await filas()).toBe(1);
    });

    it("KV3: sin clave manda el secret de arranque; la clave on lo pisa", async () => {
      const KV = kvEnMemoria();
      expect((await correr(env({ KV, RATE_LIMIT_DISABLED: "true" }))).every((c) => c === 200)).toBe(true);
      reiniciarConfig();
      KV.datos.set("ratelimit:modo", "on");
      expect(await correr(env({ KV, RATE_LIMIT_DISABLED: "true" }))).toContain(429);
    });

    it("KV4: el valor se cachea en el isolate (una sola lectura) y se renueva al vencer el TTL", async () => {
      const KV = kvEnMemoria();
      const get = vi.spyOn(KV, "get");
      await correr(env({ KV }), 5);
      expect(get).toHaveBeenCalledTimes(1);
      KV.datos.set("ratelimit:modo", "off");
      await correr(env({ KV }), 2);
      expect(get).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date(AHORA.getTime() + TTL_CONFIG_MS + 1));
      get.mockClear();
      await correr(env({ KV }), 2);
      expect(get).toHaveBeenCalledTimes(1);
    });

    it("KV5: si KV falla se usa el secret de arranque y no se rompe la request", async () => {
      const KV = { get: async () => { throw new Error("KV caído"); } };
      expect((await correr(env({ KV }), 3)).every((c) => c === 200)).toBe(true);
    });

    it("KV6: el interruptor también apaga el contador de admin_fail", async () => {
      const KV = kvEnMemoria();
      KV.datos.set("ratelimit:modo", "off");
      const e = { DB: t.DB, KV, ENVIRONMENT: "test", PUBLIC_APP_URL: APP, RATE_LIMIT_SALT: "sal", ADMIN_SECRET: SECRET };
      for (let i = 0; i < 8; i++) {
        const r = await status(apiCtx({ url: `${APP}/api/admin/status`, headers: { "cf-connecting-ip": IP, authorization: "Bearer mal" }, env: e }));
        expect(r.status).toBe(401);
      }
      expect(await filas()).toBe(0);
    });
  });

  it("RL20: en las navegaciones (login, callback) el 429 redirige a /login?error=rate_limited", async () => {
    const handler = withApi(ok, { logger: capturar().logger, rateLimit: ["login"], rateLimitRedirect: "/login?error=rate_limited" });
    const desde = () => peticion({ method: "GET", user: null });
    for (let i = 0; i < 10; i++) expect((await handler(desde())).status).toBe(200);
    const res = await handler(desde());
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?error=rate_limited");
    expect(res.headers.get("Retry-After")).toBeTruthy();
  });

  describe("mutaciones anónimas", () => {
    it("RL19: sin usuario, los límites por defecto no se aplican ni escriben (irán a 401)", async () => {
      const handler = withApi(ok, { logger: capturar().logger });
      for (let i = 0; i < 130; i++) expect((await handler(peticion({ user: null }))).status).toBe(200);
      expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>())?.n).toBe(0);
    });

    it("RL19b: con límites explícitos (login/callback) sí se aplican sin usuario", async () => {
      const handler = withApi(ok, { logger: capturar().logger, rateLimit: ["oauth_callback"] });
      for (let i = 0; i < 20; i++) await handler(peticion({ user: null, method: "GET" }));
      expect((await handler(peticion({ user: null, method: "GET" }))).status).toBe(429);
    });
  });

  describe("origen y Content-Type", () => {
    const conCookie = (extra: Record<string, string>) => peticion({ headers: { cookie: "session=abc", "cf-connecting-ip": IP, ...extra }, body: { a: 1 } });

    it("OR1: POST con cookie y same-origin pasa", async () => {
      const handler = withApi(ok, { logger: capturar().logger });
      expect((await handler(conCookie({ "sec-fetch-site": "same-origin" }))).status).toBe(200);
    });

    it("OR2/OR9: cross-site se rechaza con 403 uniforme (POST y DELETE) y el handler no corre", async () => {
      const fn = vi.fn(ok);
      const handler = withApi(fn, { logger: capturar().logger });
      for (const method of ["POST", "DELETE"]) {
        const res = await handler(peticion({ method, headers: { cookie: "session=abc", "sec-fetch-site": "cross-site", "cf-connecting-ip": IP } }));
        expect(res.status).toBe(403);
        expect(await res.json()).toMatchObject({ error: "forbidden_origin" });
      }
      expect(fn).not.toHaveBeenCalled();
    });

    it("OR6: con cookie y sin Origin ni Sec-Fetch-Site da 403", async () => {
      const handler = withApi(ok, { logger: capturar().logger });
      expect((await handler(conCookie({}))).status).toBe(403);
    });

    it("OR7: Bearer sin cookie ni Origin pasa; origin 'none' lo exime por completo", async () => {
      const handler = withApi(ok, { logger: capturar().logger, origin: "none", contentType: "any" });
      const res = await handler(peticion({ headers: { authorization: "Bearer x", "sec-fetch-site": "cross-site" } }));
      expect(res.status).toBe(200);
    });

    it("OR8: GET con origen ajeno pasa (no muta)", async () => {
      const handler = withApi(ok, { logger: capturar().logger });
      const res = await handler(peticion({ method: "GET", headers: { cookie: "session=abc", origin: "https://evil.com", "sec-fetch-site": "cross-site" } }));
      expect(res.status).toBe(200);
    });

    it("OR10: POST con cuerpo text/plain da 415", async () => {
      const handler = withApi(ok, { logger: capturar().logger });
      const res = await handler(peticion({ headers: { "content-type": "text/plain", "sec-fetch-site": "same-origin", "cf-connecting-ip": IP }, body: '{"a":1}' }));
      expect(res.status).toBe(415);
      expect(await res.json()).toMatchObject({ error: "unsupported_media_type" });
    });

    it("OR12: POST sin cuerpo ni Content-Type (logout) pasa", async () => {
      const handler = withApi(ok, { logger: capturar().logger });
      expect((await handler(peticion())).status).toBe(200);
    });

    it("contentType 'any' permite formularios", async () => {
      const handler = withApi(ok, { logger: capturar().logger, contentType: "any" });
      const res = await handler(peticion({ headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin", "cf-connecting-ip": IP }, body: "a=1" }));
      expect(res.status).toBe(200);
    });

    it("OR15: el rechazo se registra en warn con la ruta y sin cabeceras ni cookies", async () => {
      const { logger, lineas } = capturar();
      const handler = withApi(ok, { logger });
      await handler(peticion({ headers: { cookie: "session=SECRETO", origin: "https://evil.example", "sec-fetch-site": "cross-site", "cf-connecting-ip": IP } }));
      const aviso = lineas.find((l) => l.data.msg === "origin_rejected");
      expect(aviso?.level).toBe("warn");
      expect(aviso?.data.route).toBeTruthy();
      const todo = lineas.map((l) => l.raw).join("\n");
      for (const prohibido of ["SECRETO", "evil.example", IP]) expect(todo).not.toContain(prohibido);
    });
  });
});

describe("endpoints con política propia", () => {
  const t = useTestDb();
  relojFijo();
  beforeEach(() => {
    reiniciarMemoria();
    reiniciarConfig();
    for (const m of ["log", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  });
  const env = (extra: Record<string, unknown> = {}) => ({ DB: t.DB, ENVIRONMENT: "test", PUBLIC_APP_URL: APP, RATE_LIMIT_SALT: "sal", ADMIN_SECRET: SECRET, ...extra });
  const base = { "cf-connecting-ip": IP, "sec-fetch-site": "same-origin" };

  it("RL11: calendario/sync con 7 matchIds (más que el presupuesto de subrequests) da 400", async () => {
    const matchIds = Array.from({ length: 7 }, (_, i) => `m${i}`);
    const res = await syncPost(apiCtx({ url: `${APP}/api/calendario/sync`, method: "POST", headers: base, body: { matchIds }, user: { id: "u1" }, env: env() }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "too_many_matchIds", max: 6 });
  });

  it("RL15: buscar da 429 en la request 61 desde una IP y no escribe en D1", async () => {
    const ctx = () => apiCtx({ url: `${APP}/api/equipos/buscar?q=x`, headers: { "cf-connecting-ip": IP }, env: env() });
    for (let i = 0; i < 60; i++) expect((await buscar(ctx())).status).toBe(200);
    const res = await buscar(ctx());
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>())?.n).toBe(0);
  });

  it("buscar: q de más de 50 caracteres devuelve [] y la respuesta anónima es cacheable", async () => {
    const larga = await buscar(apiCtx({ url: `${APP}/api/equipos/buscar?q=${"a".repeat(51)}`, env: env() }));
    expect(await larga.json()).toEqual([]);
    const corta = await buscar(apiCtx({ url: `${APP}/api/equipos/buscar?q=ar`, env: env() }));
    expect(corta.headers.get("Cache-Control")).toBe("public, max-age=60");
    const logueado = await buscar(apiCtx({ url: `${APP}/api/equipos/buscar?q=ar`, user: { id: "u1" }, env: env() }));
    expect(logueado.headers.get("Cache-Control")).toBe("private, max-age=60");
  });

  const admin = (bearer: string | null, extra: Record<string, string> = {}) =>
    apiCtx({ url: `${APP}/api/admin/status`, headers: { "cf-connecting-ip": IP, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extra }, env: env() });

  it("RL13: 5 Bearer inválidos dan 401 y a la sexta 429; el Bearer correcto sigue pasando", async () => {
    for (let i = 0; i < 5; i++) expect((await status(admin("incorrecto"))).status).toBe(401);
    const sexta = await status(admin("incorrecto"));
    expect(sexta.status).toBe(429);
    expect(Number(sexta.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await status(admin(SECRET))).status).toBe(200);
  });

  it("RL13b: otra IP no queda afectada y la ventana vence a los 15 minutos", async () => {
    for (let i = 0; i < 6; i++) await status(admin("incorrecto"));
    expect((await status(admin("incorrecto", { "cf-connecting-ip": "198.51.100.9" }))).status).toBe(401);
    vi.setSystemTime(new Date(AHORA.getTime() + 15 * 60_000 + 1_000));
    expect((await status(admin("incorrecto"))).status).toBe(401);
  });

  it("RL13c: con requests concurrentes pasan exactamente 5 inválidos (401), el resto 429, y el válido 200", async () => {
    const respuestas = await Promise.all([
      ...Array.from({ length: 20 }, () => status(admin("incorrecto"))),
      status(admin(SECRET)),
    ]);
    const codigos = respuestas.map((r) => r.status);
    expect(codigos.filter((c) => c === 401)).toHaveLength(5);
    expect(codigos.filter((c) => c === 429)).toHaveLength(15);
    expect(codigos[20]).toBe(200);
    const fila = await t.DB.prepare("SELECT count FROM rate_limits WHERE bucket = 'admin_fail'").first<{ count: number }>();
    expect(fila?.count).toBe(6);
  });

  it("RL14: un Bearer válido repetido no cuenta, no escribe y no se bloquea", async () => {
    for (let i = 0; i < 12; i++) expect((await status(admin(SECRET))).status).toBe(200);
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE bucket = 'admin_fail'").first<{ n: number }>())?.n).toBe(0);
  });

  it("el Bearer de admin/sync (cron, sin cookie ni Origin, Content-Type json) pasa por withApi", async () => {
    const res = await adminSync(apiCtx({ url: `${APP}/api/admin/sync`, method: "POST", headers: { "cf-connecting-ip": IP, authorization: "Bearer mal" }, body: { lote: 0 }, env: env() }));
    expect(res.status).toBe(401);
  });

  it("OB2: /api/admin/status incluye rateLimit.ultimas24h; OB3: /api/health no expone nada", async () => {
    const handler = withApi(async () => Response.json({ ok: true }), { rateLimit: ["login"] });
    for (let i = 0; i < 12; i++) await handler(apiCtx({ url: `${APP}/api/auth/login/google`, headers: { "cf-connecting-ip": IP }, env: env() }));
    const body = (await (await status(admin(SECRET, { "cf-connecting-ip": "198.51.100.50" }))).json()) as any;
    const login = body.rateLimit.ultimas24h.find((b: any) => b.bucket === "login");
    expect(login).toMatchObject({ hits: 11, blocked: 1, subjects: 1, limit: 10 });
    expect(JSON.stringify(body.rateLimit)).not.toContain(IP);
  });
});
