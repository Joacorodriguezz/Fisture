// DELETE /api/cuenta contra D1 real de Miniflare (docs/14-borrado-de-cuenta-tdd.md, casos C1 a C13).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../helpers/use-test-db";
import { relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { calendarSyncs, userPreferences, userTeams, users } from "../../../drizzle/schema";

const { revocar, validar } = vi.hoisted(() => ({ revocar: vi.fn(), validar: vi.fn() }));
vi.mock("../../../src/lib/auth/providers", () => ({
  createGoogleProvider: () => ({ revokeToken: revocar, validateAuthorizationCode: validar }),
  createMicrosoftProvider: () => ({ validateAuthorizationCode: validar }),
  isValidProvider: (p: string) => ["google", "microsoft"].includes(p),
}));

import { DELETE } from "../../../src/pages/api/cuenta";
import { GET as callback } from "../../../src/pages/api/auth/callback/[provider]";

const APP_URL = "https://fisture.test";

describe("DELETE /api/cuenta", () => {
  const t = useTestDb();
  let f: Awaited<ReturnType<typeof seedApp>>;
  let kv: ReturnType<typeof kvEnMemoria>;
  let cookies: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  relojFijo();

  beforeEach(async () => {
    silenciarConsola(vi);
    revocar.mockReset().mockResolvedValue(undefined);
    kv = kvEnMemoria();
    cookies = { get: vi.fn(() => ({ value: "sid-1" })), delete: vi.fn() };
    kv.datos.set("session:sid-1", "user-1");
    f = await seedApp(t.db);
    // Datos colgados de ambos usuarios
    for (const id of ["user-1", "user-2"]) {
      await t.db.insert(userTeams).values({ userId: id, teamId: "river" });
      await t.db.insert(userPreferences).values({ userId: id });
      await t.db.insert(calendarSyncs).values({ userId: id, matchId: "superclasico", provider: id === "user-1" ? "google" : "microsoft", status: "synced" });
    }
    await t.db.update(users).set({ refreshToken: "rt-secreto" }).where(eq(users.id, "user-1"));
  });

  const llamar = (
    opts: { user?: { id: string } | null; body?: unknown; headers?: Record<string, string>; DB?: unknown } = {}
  ) =>
    DELETE(
      apiCtx({
        url: `${APP_URL}/api/cuenta`,
        method: "DELETE",
        user: "user" in opts ? opts.user : f.user,
        body: "body" in opts ? opts.body : { confirmar: f.user.email },
        headers: opts.headers,
        env: { ENVIRONMENT: "test", DB: opts.DB ?? t.DB, KV: kv, PUBLIC_APP_URL: APP_URL },
        over: { cookies },
      })
    );

  // Filas que cuelgan de un usuario (todas deben ser 0 tras borrarlo)
  const filasDe = async (id: string) => {
    const n = async (tabla: string, col: string) =>
      (await t.DB.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE ${col} = ?`).bind(id).first<{ n: number }>())!.n;
    return {
      users: await n("users", "id"),
      user_teams: await n("user_teams", "user_id"),
      user_preferences: await n("user_preferences", "user_id"),
      calendar_syncs: await n("calendar_syncs", "user_id"),
    };
  };
  const huerfanas = async () =>
    (await t.DB.prepare(
      `SELECT (SELECT COUNT(*) FROM user_teams WHERE user_id NOT IN (SELECT id FROM users))
            + (SELECT COUNT(*) FROM user_preferences WHERE user_id NOT IN (SELECT id FROM users))
            + (SELECT COUNT(*) FROM calendar_syncs WHERE user_id NOT IN (SELECT id FROM users)) AS n`
    ).first<{ n: number }>())!.n;

  it("C1: sin sesión responde 401 y no borra nada", async () => {
    const res = await llamar({ user: null });
    expect(res.status).toBe(401);
    expect((await filasDe("user-1")).users).toBe(1);
  });

  it("C2: JSON inválido o sin confirmar responde 400", async () => {
    expect((await llamar({ body: "{no es json" })).status).toBe(400);
    expect((await llamar({ body: {} })).status).toBe(400);
    expect((await llamar({ body: { confirmar: 42 } })).status).toBe(400);
    expect((await filasDe("user-1")).users).toBe(1);
  });

  it("C3: una confirmación que no coincide con el email responde 400 y no borra", async () => {
    const res = await llamar({ body: { confirmar: "otro@example.test" } });
    expect(res.status).toBe(400);
    expect(await filasDe("user-1")).toEqual({ users: 1, user_teams: 1, user_preferences: 1, calendar_syncs: 1 });
  });

  it("C4: confirmando (otra capitalización) borra el usuario y toda su cascada", async () => {
    const antes = await filasDe("user-1");
    expect(antes).toEqual({ users: 1, user_teams: 1, user_preferences: 1, calendar_syncs: 1 });

    const res = await llamar({ body: { confirmar: "  ANA@Example.TEST " } });

    expect(res.status).toBe(200);
    expect(await filasDe("user-1")).toEqual({ users: 0, user_teams: 0, user_preferences: 0, calendar_syncs: 0 });
    expect(await huerfanas()).toBe(0);
  });

  it("C5: no toca los datos de otros usuarios", async () => {
    await llamar();
    expect(await filasDe("user-2")).toEqual({ users: 1, user_teams: 1, user_preferences: 1, calendar_syncs: 1 });
  });

  it("C9: borra la sesión actual en KV y la cookie", async () => {
    await llamar();
    expect(kv.datos.has("session:sid-1")).toBe(false);
    expect(cookies.delete).toHaveBeenCalledWith("session", { path: "/" });
  });

  it("C10: el mismo email vuelve a registrarse como cuenta nueva y limpia", async () => {
    await llamar();
    validar.mockResolvedValue({ accessToken: () => "at-2", refreshToken: () => "rt-2", accessTokenExpiresAt: () => new Date("2027-01-01") });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "provider-1", email: "ana@example.test", name: "Ana" })));
    await kv.put("oauth:st", JSON.stringify({ codeVerifier: "cv", provider: "google", next: null }));

    await callback(
      apiCtx({
        url: `${APP_URL}/api/auth/callback/google?code=c&state=st`,
        params: { provider: "google" },
        env: { ENVIRONMENT: "test", DB: t.DB, KV: kv },
        over: { cookies: { set: vi.fn(), delete: vi.fn() }, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );

    const nuevo = await t.db.query.users.findFirst({ where: eq(users.email, "ana@example.test") });
    expect(nuevo).toBeDefined();
    expect(nuevo!.id).not.toBe("user-1");
    expect(await filasDe(nuevo!.id)).toEqual({ users: 1, user_teams: 0, user_preferences: 0, calendar_syncs: 0 });
  });

  it("C13: si falla el DELETE en D1 responde 500, la sesión sigue y no se revoca nada", async () => {
    const fallida = new Proxy(t.DB, {
      get(target, prop) {
        if (prop === "batch" || prop === "prepare") {
          return () => {
            throw new Error("D1 caída");
          };
        }
        const v = (target as any)[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });

    const res = await llamar({ DB: fallida });

    expect(res.status).toBe(500);
    expect(kv.datos.has("session:sid-1")).toBe(true);
    expect(cookies.delete).not.toHaveBeenCalled();
    expect(revocar).not.toHaveBeenCalled();
    expect((await filasDe("user-1")).users).toBe(1);
  });
});
