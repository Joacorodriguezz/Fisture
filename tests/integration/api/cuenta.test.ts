// DELETE /api/cuenta contra D1 real de Miniflare (docs/14-borrado-de-cuenta-tdd.md, casos C1 a C14).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../helpers/use-test-db";
import { relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { tokensFalsos } from "../../helpers/id-token";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { OAUTH_STATE_SECRET, cookieDeEstado, cookiesEnMemoria } from "../../helpers/oauth-state";
import { createSession, getSessionUser } from "../../../src/lib/auth/session";
import { encryptToken } from "../../../src/lib/auth/token-crypto";
import { ENV_CON_CLAVE, TOKEN_ENCRYPTION_KEY } from "../../helpers/token-key";
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
    await t.db.update(users).set({ refreshToken: await encryptToken(ENV_CON_CLAVE, "rt-secreto", "user-1:refresh_token") }).where(eq(users.id, "user-1"));
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
        env: { ENVIRONMENT: "test", DB: opts.DB ?? t.DB, KV: kv, PUBLIC_APP_URL: APP_URL, TOKEN_ENCRYPTION_KEY },
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
            + (SELECT COUNT(*) FROM calendar_syncs WHERE user_id NOT IN (SELECT id FROM users))
            + (SELECT COUNT(*) FROM prode_group_members WHERE user_id NOT IN (SELECT id FROM users))
            + (SELECT COUNT(*) FROM prode_groups WHERE owner_id NOT IN (SELECT id FROM users)) AS n`
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
    validar.mockResolvedValue(tokensFalsos({ idToken: { sub: "provider-1", email: "ana@example.test", email_verified: true, name: "Ana" }, access: "at-2", refresh: "rt-2" }));
    const estado = await cookieDeEstado({ state: "st" });
    const cookiesLogin = cookiesEnMemoria({ [estado.nombre]: estado.valor });

    await callback(
      apiCtx({
        url: `${APP_URL}/api/auth/callback/google?code=c&state=st`,
        params: { provider: "google" },
        env: { ENVIRONMENT: "test", DB: t.DB, KV: kv, OAUTH_STATE_SECRET, TOKEN_ENCRYPTION_KEY },
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
      const guardado = refreshToken === null || refreshToken.startsWith("enc:v1:") ? refreshToken : await encryptToken(ENV_CON_CLAVE, refreshToken, `${id}:refresh_token`);
      await t.db.update(users).set({ refreshToken: guardado }).where(eq(users.id, id));
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

    it("K17: con el refresh token cifrado la revocación recibe el token descifrado", async () => {
      const user = await conToken("user-1", await encryptToken(ENV_CON_CLAVE, "rt-cifrado", "user-1:refresh_token"));
      expect((await llamar({ user })).status).toBe(200);
      expect(revocar).toHaveBeenCalledTimes(1);
      expect(revocar).toHaveBeenCalledWith("rt-cifrado");
    });

    it("K17: con la identidad cifrada (id distinto del usuario) también se descifra", async () => {
      await t.DB.prepare("INSERT INTO oauth_identities (id, user_id, provider, provider_id, refresh_token) VALUES ('id-g', 'user-1', 'google', 'p-g', ?)")
        .bind(await encryptToken(ENV_CON_CLAVE, "rt-identidad", "id-g:refresh_token")).run();
      const user = (await t.db.query.users.findFirst({ where: eq(users.id, "user-1") }))!;
      expect((await llamar({ user })).status).toBe(200);
      expect(revocar).toHaveBeenCalledWith("rt-identidad");
    });

    it("K17: si el token cifrado no se puede leer (sin clave) borra igual y no revoca", async () => {
      const user = await conToken("user-1", await encryptToken(ENV_CON_CLAVE, "rt-cifrado", "user-1:refresh_token"));
      const res = await DELETE(
        apiCtx({
          url: `${APP_URL}/api/cuenta`,
          method: "DELETE",
          user,
          body: { confirmar: user.email },
          env: { ENVIRONMENT: "test", DB: t.DB, KV: kv, PUBLIC_APP_URL: APP_URL },
          over: { cookies },
        })
      );
      expect(res.status).toBe(200);
      expect((await filasDe("user-1")).users).toBe(0);
      expect(revocar).not.toHaveBeenCalled();
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

    // docs/18 V-22: con varias identidades se revoca el acceso de todas, y caen por cascade
    const identidad = async (id: string, userId: string, provider: string, refreshToken: string | null) =>
      t.DB.prepare("INSERT INTO oauth_identities (id, user_id, provider, provider_id, refresh_token) VALUES (?, ?, ?, ?, ?)").bind(id, userId, provider, `p-${id}`, refreshToken === null ? null : await encryptToken(ENV_CON_CLAVE, refreshToken, `${id}:refresh_token`)).run();
    const identidadesDe = async (userId: string) =>
      (await t.DB.prepare("SELECT COUNT(*) AS n FROM oauth_identities WHERE user_id = ?").bind(userId).first<{ n: number }>())!.n;

    it("V-22: revoca la identidad de Google vinculada a una cuenta cuyo calendario es Microsoft", async () => {
      await identidad("user-2", "user-2", "microsoft", "rt-ms");
      await identidad("id-g", "user-2", "google", "rt-google-vinculado");
      const user = (await t.db.query.users.findFirst({ where: eq(users.id, "user-2") }))!;

      const res = await llamar({ user, body: { confirmar: user.email } });

      expect(res.status).toBe(200);
      expect(revocar).toHaveBeenCalledTimes(1);
      expect(revocar).toHaveBeenCalledWith("rt-google-vinculado");
      expect(await identidadesDe("user-2")).toBe(0);
    });

    it("V-22: usa el token de la identidad y no el copiado en users.*, y no revoca dos veces", async () => {
      await identidad("user-1", "user-1", "google", "rt-de-la-identidad");
      const user = await conToken("user-1", "rt-viejo-en-users");

      await llamar({ user });

      expect(revocar).toHaveBeenCalledTimes(1);
      expect(revocar).toHaveBeenCalledWith("rt-de-la-identidad");
      expect(await identidadesDe("user-1")).toBe(0);
    });

    it("V-22: las identidades de otro usuario no se tocan", async () => {
      await identidad("user-1", "user-1", "google", "rt-1");
      await identidad("user-2", "user-2", "microsoft", "rt-2");
      await llamar({ user: await conToken("user-1", "rt-1") });
      expect(await identidadesDe("user-2")).toBe(1);
    });

    it("C8: un usuario sin refresh token no intenta revocar", async () => {
      const user = await conToken("user-1", null);
      const res = await llamar({ user });
      expect(res.status).toBe(200);
      expect(revocar).not.toHaveBeenCalled();
    });
  });

  // Grupos privados del prode: el grupo sobrevive a la baja de su dueño (pasa al integrante más antiguo)
  describe("grupos del prode", () => {
    const grupo = (id: string, ownerId: string) =>
      t.DB.prepare("INSERT INTO prode_groups (id, name, invite_code, owner_id, created_at) VALUES (?, ?, ?, ?, 1)").bind(id, `Grupo ${id}`, `codigo-${id}`, ownerId).run();
    const integrante = (groupId: string, userId: string, joinedAt: number) =>
      t.DB.prepare("INSERT INTO prode_group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)").bind(groupId, userId, joinedAt).run();
    const dueno = async (groupId: string) =>
      (await t.DB.prepare("SELECT owner_id FROM prode_groups WHERE id = ?").bind(groupId).first<{ owner_id: string }>())?.owner_id ?? null;
    const integrantes = async (groupId: string) =>
      (await t.DB.prepare("SELECT user_id FROM prode_group_members WHERE group_id = ? ORDER BY joined_at").bind(groupId).all<{ user_id: string }>()).results.map((r) => r.user_id);

    beforeEach(async () => {
      await t.DB.prepare("INSERT INTO users (id, provider, provider_id, email, name) VALUES ('user-3', 'google', 'provider-3', 'eva@example.test', 'Eva')").run();
    });

    it("G1: si el dueño borra su cuenta, el grupo sigue y pasa al integrante más antiguo", async () => {
      await grupo("g1", "user-1");
      await integrante("g1", "user-1", 100);
      await integrante("g1", "user-3", 300);
      await integrante("g1", "user-2", 200);

      const res = await llamar();

      expect(res.status).toBe(200);
      expect(await dueno("g1")).toBe("user-2");
      expect(await integrantes("g1")).toEqual(["user-2", "user-3"]);
      expect(await huerfanas()).toBe(0);
    });

    it("G2: si el dueño es el único integrante, el grupo desaparece", async () => {
      await grupo("g2", "user-1");
      await integrante("g2", "user-1", 100);

      expect((await llamar()).status).toBe(200);

      expect(await dueno("g2")).toBeNull();
      expect(await integrantes("g2")).toEqual([]);
      expect(await huerfanas()).toBe(0);
    });

    it("G3: un integrante que no es dueño sale del grupo y el grupo no cambia", async () => {
      await grupo("g3", "user-2");
      await integrante("g3", "user-2", 100);
      await integrante("g3", "user-1", 200);

      expect((await llamar()).status).toBe(200);

      expect(await dueno("g3")).toBe("user-2");
      expect(await integrantes("g3")).toEqual(["user-2"]);
    });

    it("G4: el log cuenta membresías, grupos transferidos y grupos borrados", async () => {
      const { deleteAccount } = await import("../../../src/lib/db/account");
      await grupo("ga", "user-1");
      await integrante("ga", "user-1", 100);
      await integrante("ga", "user-2", 200);
      await grupo("gb", "user-1");
      await integrante("gb", "user-1", 100);
      await grupo("gc", "user-2");
      await integrante("gc", "user-2", 100);
      await integrante("gc", "user-1", 200);

      const filas = await deleteAccount(t.DB as never, "user-1");

      expect(filas).toMatchObject({ users: 1, prodeGroupMembers: 3, prodeGroupsTransferidos: 1, prodeGroups: 1 });
    });

    it("G5: la FK no deja borrar al dueño de un grupo sin transferirlo antes (RESTRICT)", async () => {
      await grupo("g5", "user-1");
      await integrante("g5", "user-1", 100);
      await expect(t.DB.prepare("DELETE FROM users WHERE id = 'user-1'").run()).rejects.toThrow(/FOREIGN KEY/);
      expect(await dueno("g5")).toBe("user-1");
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
