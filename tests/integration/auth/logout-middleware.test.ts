// Middleware y logout sobre sesiones en D1 (docs/21, S8, S9, S11).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { createSession } from "../../../src/lib/auth/session";

vi.mock("astro:middleware", () => ({ defineMiddleware: (fn: unknown) => fn }));

import { onRequest } from "../../../src/middleware";
import { GET as logout } from "../../../src/pages/api/auth/logout";

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

  it("S11: logout borra la fila y la cookie, con 0 operaciones de KV", async () => {
    const token = await createSession(t.db, "user-1");
    const cookies = { get: () => ({ value: token }), delete: vi.fn() };

    const res = await logout(
      apiCtx({
        url: "https://fisture.test/api/auth/logout",
        env: { DB: t.DB, KV: kv },
        over: { cookies, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );

    expect(res.headers.get("Location")).toBe("/");
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n).toBe(0);
    expect(cookies.delete).toHaveBeenCalledWith("session", { path: "/" });
    expect(operacionesKv).toEqual([]);
  });

  it("S11: sin cookie igual redirige a / sin consultar la base", async () => {
    const consultas: string[] = [];
    const DB = { prepare: (sql: string) => (consultas.push(sql), t.DB.prepare(sql)) };
    const res = await logout(
      apiCtx({
        url: "https://fisture.test/api/auth/logout",
        env: { DB, KV: kv },
        over: { cookies: { get: () => undefined, delete: vi.fn() }, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );
    expect(res.headers.get("Location")).toBe("/");
    expect(consultas).toEqual([]);
  });
});
