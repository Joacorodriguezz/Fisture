// DELETE /api/cuenta contra D1 real de Miniflare (docs/14-borrado-de-cuenta-tdd.md, casos C1 a C14).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../helpers/use-test-db";
import { relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { OAUTH_STATE_SECRET, cookieDeEstado, cookiesEnMemoria } from "../../helpers/oauth-state";
import { createSession, getSessionUser } from "../../../src/lib/auth/session";
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
  let sidUsuario1: string;
  let sidUsuario2: string;
  let cookies: { get: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };
  relojFijo();

  beforeEach(async () => {
    silenciarConsola(vi);
    revocar.mockReset().mockResolvedValue(undefined);
    kv = kvEnMemoria();
    cookies = { get: vi.fn(), delete: vi.fn() };
    f = await seedApp(t.db);
    sidUsuario1 = await createSession(t.db, "user-1");
    sidUsuario2 = await createSession(t.db, "user-2");
    cookies.get.mockReturnValue({ value: sidUsuario1 });
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

  it("C9: borra la cookie y las sesiones del usuario caen por cascada", async () => {
    await llamar();
    expect(await getSessionUser(t.db, sidUsuario1)).toBeNull();
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = 'user-1'").first<{ n: number }>())!.n).toBe(0);
    expect(cookies.delete).toHaveBeenCalledWith("session", { path: "/" });
  });

  it("S12: no toca KV y deja intactas las sesiones de otros usuarios", async () => {
    const ops = vi.spyOn(kv, "delete");
    const user = (await t.db.query.users.findFirst({ where: eq(users.id, "user-1") }))!;
    const res = await llamar({ user });
    expect(res.status).toBe(200);
    expect(ops).not.toHaveBeenCalled();
    expect(await getSessionUser(t.db, sidUsuario2)).toMatchObject({ id: "user-2" });
    expect(revocar).toHaveBeenCalledWith("rt-secreto");
  });

  it("C10: el mismo email vuelve a registrarse como cuenta nueva y limpia", async () => {
    await llamar();
    validar.mockResolvedValue({ accessToken: () => "at-2", refreshToken: () => "rt-2", accessTokenExpiresAt: () => new Date("2027-01-01") });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "provider-1", email: "ana@example.test", name: "Ana" })));
    const estado = await cookieDeEstado({ state: "st" });
    const cookiesLogin = cookiesEnMemoria({ [estado.nombre]: estado.valor });

    await callback(
      apiCtx({
        url: `${APP_URL}/api/auth/callback/google?code=c&state=st`,
        params: { provider: "google" },
        env: { ENVIRONMENT: "test", DB: t.DB, KV: kv, OAUTH_STATE_SECRET },
        over: { cookies: cookiesLogin, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );

    const nuevo = await t.db.query.users.findFirst({ where: eq(users.email, "ana@example.test") });
    expect(nuevo).toBeDefined();
    expect(nuevo!.id).not.toBe("user-1");
    expect(await filasDe(nuevo!.id)).toEqual({ users: 1, user_teams: 0, user_preferences: 0, calendar_syncs: 0 });
  });

  describe("revocación en el proveedor", () => {
    const conToken = async (id: string, refreshToken: string | null) => {
      await t.db.update(users).set({ refreshToken }).where(eq(users.id, id));
      return (await t.db.query.users.findFirst({ where: eq(users.id, id) }))!;
    };

    it("Google: revoca el refresh token después de borrar en D1", async () => {
      const user = await conToken("user-1", "rt-secreto");
      let usuariosAlRevocar = -1;
      revocar.mockImplementation(async () => {
        usuariosAlRevocar = (await filasDe("user-1")).users;
      });

      const res = await llamar({ user });

      expect(res.status).toBe(200);
      expect(usuariosAlRevocar).toBe(0);
      expect(revocar).toHaveBeenCalledWith("rt-secreto");
    });

    it("C6: si la revocación falla responde 200 igual", async () => {
      const user = await conToken("user-1", "rt-secreto");
      revocar.mockRejectedValue(new Error("Google caído"));

      const res = await llamar({ user });

      expect(res.status).toBe(200);
      expect((await filasDe("user-1")).users).toBe(0);
    });

    it("C7: un usuario de Microsoft no intenta revocar", async () => {
      const user = await conToken("user-2", "rt-ms");
      const res = await llamar({ user, body: { confirmar: user.email } });
      expect(res.status).toBe(200);
      expect(revocar).not.toHaveBeenCalled();
    });

    it("C8: un usuario sin refresh token no intenta revocar", async () => {
      const user = await conToken("user-1", null);
      const res = await llamar({ user });
      expect(res.status).toBe(200);
      expect(revocar).not.toHaveBeenCalled();
    });
  });

  it("C11: un Origin de otro sitio responde 403 y no borra nada", async () => {
    const res = await llamar({ headers: { Origin: "https://evil.com" } });
    expect(res.status).toBe(403);
    expect(await filasDe("user-1")).toEqual({ users: 1, user_teams: 1, user_preferences: 1, calendar_syncs: 1 });
    expect(revocar).not.toHaveBeenCalled();
  });

  it("C11: el Origin de la propia app pasa", async () => {
    expect((await llamar({ headers: { Origin: APP_URL } })).status).toBe(200);
  });

  it("D8: exige Content-Type application/json (415) y no borra nada", async () => {
    const res = await llamar({ headers: { "Content-Type": "text/plain" } });
    expect(res.status).toBe(415);
    expect((await filasDe("user-1")).users).toBe(1);
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
    expect(await getSessionUser(t.db, sidUsuario1)).toMatchObject({ id: "user-1" });
    expect(cookies.delete).not.toHaveBeenCalled();
    expect(revocar).not.toHaveBeenCalled();
    expect((await filasDe("user-1")).users).toBe(1);
  });
});
