// Middleware y logout sobre sesiones en D1 (docs/21, S8, S9, S11).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { createSession } from "../../../src/lib/auth/session";

type Mw = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
vi.mock("astro:middleware", () => ({
  defineMiddleware: (fn: unknown) => fn,
  // Encadena como Astro: cada middleware recibe como `next` al siguiente
  sequence: (...fns: Mw[]) => (ctx: unknown, next: () => Promise<Response>) =>
    fns.reduceRight<() => Promise<Response>>((sig, fn) => () => fn(ctx, sig), next)(),
}));

import { onRequest } from "../../../src/middleware";
import { GET as logoutGet, POST as logout } from "../../../src/pages/api/auth/logout";

describe("middleware y logout con sesiones en D1", () => {
  const t = useTestDb();
  let kv: ReturnType<typeof kvEnMemoria>;
  let operacionesKv: string[];

  beforeEach(async () => {
    silenciarConsola(vi);
    await seedApp(t.db);
    kv = kvEnMemoria();
    operacionesKv = [];
    for (const metodo of ["get", "put", "delete"] as const) {
      const original = kv[metodo] as (...a: any[]) => Promise<unknown>;
      (kv as any)[metodo] = async (...a: any[]) => (operacionesKv.push(metodo), original(...a));
    }
  });

  const pasar = async (cookie: string | undefined, path = "/ligas") => {
    const cookies = { get: () => (cookie ? { value: cookie } : undefined), delete: vi.fn() };
    const locals: Record<string, any> = { runtime: { env: { DB: t.DB, KV: kv } } };
    const next = vi.fn(async () => new Response("ok"));
    const res = await (onRequest as any)(
      { locals, cookies, url: new URL(`https://fisture.test${path}`), redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      next
    );
    return { res, locals, cookies, next };
  };

  it("S8: cookie válida pone locals.user sin tocar KV", async () => {
    const token = await createSession(t.db, "user-1");
    const { locals, cookies, next } = await pasar(token);

    expect(locals.user).toMatchObject({ id: "user-1" });
    expect(cookies.delete).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalled();
    expect(operacionesKv).toEqual([]);
  });

  it("S8: una sola consulta a D1 para sesión y usuario", async () => {
    const token = await createSession(t.db, "user-1");
    const consultas: string[] = [];
    const DB = { prepare: (sql: string) => (consultas.push(sql), t.DB.prepare(sql)) };
    const locals: Record<string, any> = { runtime: { env: { DB, KV: kv } } };
    const cookies = { get: () => ({ value: token }), delete: vi.fn() };
    await (onRequest as any)(
      { locals, cookies, url: new URL("https://fisture.test/ligas"), redirect: vi.fn() },
      async () => new Response("ok")
    );
    expect(consultas).toHaveLength(1);
    expect(locals.user).toMatchObject({ id: "user-1" });
  });

  it("S9: cookie inválida o expirada no da usuario y borra la cookie", async () => {
    const { locals, cookies } = await pasar("inexistente", "/");
    expect(locals.user).toBeUndefined();
    expect(cookies.delete).toHaveBeenCalledWith("session", { path: "/" });

    const vencida = await createSession(t.db, "user-1", new Date("2020-01-01T00:00:00Z"));
    const r = await pasar(vencida, "/");
    expect(r.locals.user).toBeUndefined();
    expect(r.cookies.delete).toHaveBeenCalledWith("session", { path: "/" });
  });

  it("agrega los headers de seguridad, también a las redirecciones", async () => {
    const { res } = await pasar(undefined, "/ligas");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");

    const r = await pasar(undefined, "/configuracion");
    expect(r.res.status).toBe(302);
    expect(r.res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("S11: logout (POST) borra la fila y la cookie, con 0 operaciones de KV", async () => {
    const token = await createSession(t.db, "user-1");
    const cookies = { get: () => ({ value: token }), delete: vi.fn() };

    const res = await logout(
      apiCtx({
        url: "https://fisture.test/api/auth/logout",
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
        env: { DB: t.DB, KV: kv },
        over: { cookies, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );

    expect(res.headers.get("Location")).toBe("/");
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n).toBe(0);
    expect(cookies.delete).toHaveBeenCalledWith("session", { path: "/" });
    expect(operacionesKv).toEqual([]);
  });

  it("LO1: un GET responde 405 y no cierra la sesión ni redirige", async () => {
    const token = await createSession(t.db, "user-1");
    const cookies = { get: () => ({ value: token }), delete: vi.fn() };
    const res = await logoutGet(
      apiCtx({ url: "https://fisture.test/api/auth/logout", over: { cookies, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) } })
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("POST");
    expect(res.headers.get("Location")).toBeNull();
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n).toBe(1);
    expect(cookies.delete).not.toHaveBeenCalled();
  });

  it("LO2: un POST cross-site (CSRF) da 403 y no cierra la sesión", async () => {
    const token = await createSession(t.db, "user-1");
    const cookies = { get: () => ({ value: token }), delete: vi.fn() };
    const res = await logout(
      apiCtx({
        url: "https://fisture.test/api/auth/logout",
        method: "POST",
        headers: { "sec-fetch-site": "cross-site", origin: "https://evil.example", cookie: `session=${token}` },
        env: { DB: t.DB, KV: kv, PUBLIC_APP_URL: "https://fisture.test" },
        over: { cookies },
      })
    );
    expect(res.status).toBe(403);
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n).toBe(1);
  });

  it("LO3: el formulario del navegador (urlencoded vacío) pasa y redirige con 303", async () => {
    const res = await logout(
      apiCtx({
        url: "https://fisture.test/api/auth/logout",
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded" },
        env: { DB: t.DB, KV: kv },
        over: { cookies: { get: () => undefined, delete: vi.fn() }, redirect: (d: string, s = 302) => new Response(null, { status: s, headers: { Location: d } }) },
      })
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("Location")).toBe("/");
  });

  it("S11: sin cookie igual redirige a / sin consultar la base", async () => {
    const consultas: string[] = [];
    const DB = { prepare: (sql: string) => (consultas.push(sql), t.DB.prepare(sql)) };
    const res = await logout(
      apiCtx({
        url: "https://fisture.test/api/auth/logout",
        method: "POST",
        headers: { "sec-fetch-site": "same-origin" },
        env: { DB, KV: kv },
        over: { cookies: { get: () => undefined, delete: vi.fn() }, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );
    expect(res.headers.get("Location")).toBe("/");
    expect(consultas).toEqual([]);
  });
  it("docs/29 C1: en producción, otro host da 301 al dominio canónico sin consultar D1 ni seguir", async () => {
    const consultas: string[] = [];
    const DB = { prepare: (sql: string) => (consultas.push(sql), t.DB.prepare(sql)) };
    const locals: Record<string, any> = { runtime: { env: { DB, KV: kv, ENVIRONMENT: "production", PUBLIC_APP_URL: "https://fisture.test" } } };
    const next = vi.fn(async () => new Response("ok"));
    const url = new URL("https://fisture.pages.dev/ligas?x=1");
    const res = await (onRequest as any)(
      { locals, cookies: { get: () => undefined, delete: vi.fn() }, url, request: new Request(url), redirect: vi.fn() },
      next
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe("https://fisture.test/ligas?x=1");
    expect(next).not.toHaveBeenCalled();
    expect(consultas).toEqual([]);
  });
});
