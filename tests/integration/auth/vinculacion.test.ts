// Vinculación segura de cuentas OAuth (docs/18-vinculacion-de-cuentas-tdd.md, casos V-01 a V-17 y V-20).
// Reproduce el ataque "nOAuth": la identidad es (provider, provider_id) y el email nunca identifica a nadie.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { apiCtx, silenciarConsola } from "../../helpers/ctx";
import { cookieDeEstado, cookiesEnMemoria } from "../../helpers/oauth-state";
import { OAUTH_STATE_SECRET } from "../../helpers/oauth-state";
import { tokensFalsos } from "../../helpers/id-token";

const { validar } = vi.hoisted(() => ({ validar: vi.fn() }));
vi.mock("../../../src/lib/auth/providers", () => ({
  createGoogleProvider: () => ({ validateAuthorizationCode: validar }),
  createMicrosoftProvider: () => ({ validateAuthorizationCode: validar }),
  isValidProvider: (p: string) => ["google", "microsoft"].includes(p),
}));

import { GET } from "../../../src/pages/api/auth/callback/[provider]";

interface Cuenta {
  id: string;
  email: string;
  provider: "google" | "microsoft";
  providerId: string;
  verificado: boolean;
  access?: string;
  refresh?: string;
}

describe("callback OAuth: identidad por (provider, provider_id)", () => {
  const t = useTestDb();
  let cookies: ReturnType<typeof cookiesEnMemoria>;

  const llamar = (provider: string, intent: { intent?: "login" | "link"; userId?: string } = {}, user?: { id: string }) =>
    cookieDeEstado({ provider, ...intent }).then(({ nombre, valor }) => {
      cookies.valores.set(nombre, valor);
      return GET(
        apiCtx({
          url: `https://fisture.test/api/auth/callback/${provider}?code=c&state=st-1`,
          params: { provider },
          user,
          env: { ENVIRONMENT: "production", DB: t.DB, OAUTH_STATE_SECRET },
          over: { cookies, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
        })
      );
    });

  const sembrar = async (c: Cuenta) => {
    await t.DB.batch([
      t.DB.prepare(
        "INSERT INTO users (id, email, email_verified, name, provider, provider_id, access_token, refresh_token) VALUES (?1, ?2, ?3, 'Nombre', ?4, ?5, ?6, ?7)"
      ).bind(c.id, c.email, c.verificado ? 1 : 0, c.provider, c.providerId, c.access ?? `at-${c.id}`, c.refresh ?? `rt-${c.id}`),
      t.DB.prepare(
        "INSERT INTO oauth_identities (id, user_id, provider, provider_id, email, email_verified, access_token, refresh_token) VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)"
      ).bind(c.id, c.provider, c.providerId, c.email, c.verificado ? 1 : 0, c.access ?? `at-${c.id}`, c.refresh ?? `rt-${c.id}`),
    ]);
  };
  const ana: Cuenta = { id: "ana", email: "ana@example.com", provider: "google", providerId: "g-1", verificado: true, access: "at-ana", refresh: "rt-ana" };

  const todo = async (sql: string) => (await t.DB.prepare(sql).all<any>()).results;
  const usuarios = () => todo("SELECT * FROM users ORDER BY id");
  const identidades = () => todo("SELECT * FROM oauth_identities ORDER BY provider, provider_id");
  const sesiones = async () => (await t.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{ n: number }>())!.n;
  const destino = (res: Response) => res.headers.get("Location");

  const google = (claims: Record<string, unknown> = {}, tokens: Parameters<typeof tokensFalsos>[0] = {}) =>
    validar.mockResolvedValue(
      tokensFalsos({ idToken: { sub: "g-1", email: "ana@example.com", email_verified: true, name: "Ana", picture: "https://img/ana.png", ...claims }, ...tokens })
    );
  const microsoft = (graph: Record<string, unknown> = {}, claims: Record<string, unknown> = {}, tokens: Parameters<typeof tokensFalsos>[0] = {}) => {
    validar.mockResolvedValue(tokensFalsos({ idToken: { oid: "m-1", tid: "tenant-1", ...claims }, ...tokens }));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "m-1", displayName: "Beto", mail: "beto@corp.com", ...graph })));
  };

  beforeEach(() => {
    silenciarConsola(vi);
    cookies = cookiesEnMemoria();
    validar.mockReset();
    vi.unstubAllGlobals();
  });

  describe("ataque nOAuth", () => {
    it("V-01: Microsoft nuevo con el mail de Ana (sin xms_edov) no entra a su cuenta ni toca sus tokens", async () => {
      await sembrar(ana);
      microsoft({ id: "m-evil", mail: "ana@example.com" }, { oid: "m-evil" }, { access: "at-evil", refresh: "rt-evil" });

      const res = await llamar("microsoft");

      expect(new URL(destino(res)!, "https://fisture.test").searchParams.get("error")).toBe("email_en_uso");
      expect(destino(res)).toMatch(/^\/login\?error=email_en_uso/);
      expect(cookies.set).not.toHaveBeenCalled();
      expect(await sesiones()).toBe(0);
      expect(await usuarios()).toMatchObject([{ id: "ana", access_token: "at-ana", refresh_token: "rt-ana", provider: "google", provider_id: "g-1" }]);
      expect(await identidades()).toMatchObject([{ id: "ana", access_token: "at-ana", refresh_token: "rt-ana" }]);
    });

    it("V-01: el mensaje nombra el proveedor de la cuenta existente", async () => {
      await sembrar(ana);
      microsoft({ id: "m-evil", mail: "ana@example.com" }, { oid: "m-evil" });
      expect(destino(await llamar("microsoft"))).toBe("/login?error=email_en_uso&proveedor=google");
    });

    it("V-02: cuenta de Ana con Microsoft y otro oid con el mismo mail: no se pisan sus tokens", async () => {
      await sembrar({ ...ana, provider: "microsoft", providerId: "m-ana", verificado: false });
      microsoft({ id: "m-evil", mail: "ana@example.com" }, { oid: "m-evil" }, { access: "at-evil" });

      const res = await llamar("microsoft");

      expect(destino(res)).toMatch(/^\/login\?error=email_en_uso/);
      expect(cookies.set).not.toHaveBeenCalled();
      expect(await usuarios()).toMatchObject([{ id: "ana", access_token: "at-ana" }]);
      expect(await identidades()).toMatchObject([{ id: "ana", provider_id: "m-ana", access_token: "at-ana" }]);
    });

    it("V-07: aunque llegue xms_edov=true, Microsoft no se auto-vincula (fail closed hasta confirmar el spike)", async () => {
      await sembrar(ana);
      microsoft({ id: "m-2", mail: "ana@example.com" }, { oid: "m-2", email: "ana@example.com", xms_edov: true });
      expect(destino(await llamar("microsoft"))).toMatch(/^\/login\?error=email_en_uso/);
      expect(await identidades()).toHaveLength(1);
    });

    it("V-17: pre-secuestro: el atacante creó la cuenta sin verificar; la dueña real no hereda esa cuenta", async () => {
      await sembrar({ id: "atacante", email: "ana@example.com", provider: "microsoft", providerId: "m-evil", verificado: false });
      google();

      const res = await llamar("google");

      expect(destino(res)).toMatch(/^\/login\?error=email_en_uso/);
      expect(cookies.set).not.toHaveBeenCalled();
      expect(await identidades()).toHaveLength(1);
    });
  });

  describe("alta, reingreso y vinculación automática", () => {
    it("alta con Google: crea usuario e identidad con el sub, email verificado y tokens", async () => {
      google();
      const res = await llamar("google");

      expect(destino(res)).toBe("/ligas");
      expect(await usuarios()).toMatchObject([
        { email: "ana@example.com", email_verified: 1, name: "Ana", image: "https://img/ana.png", provider: "google", provider_id: "g-1", access_token: "at-1", refresh_token: "rt-1" },
      ]);
      const [u] = await usuarios();
      expect(await identidades()).toMatchObject([
        { user_id: u.id, provider: "google", provider_id: "g-1", email: "ana@example.com", email_verified: 1, access_token: "at-1", refresh_token: "rt-1", token_expires_at: new Date("2027-01-01T00:00:00Z").getTime() },
      ]);
      expect(cookies.set).toHaveBeenCalledOnce();
      expect(await sesiones()).toBe(1);
    });

    it("alta con Microsoft: guarda el oid de Graph y el tid, y no marca el email como verificado", async () => {
      microsoft();
      expect(destino(await llamar("microsoft"))).toBe("/ligas");
      expect(await usuarios()).toMatchObject([{ email: "beto@corp.com", email_verified: 0, provider: "microsoft", provider_id: "m-1" }]);
      expect(await identidades()).toMatchObject([{ provider: "microsoft", provider_id: "m-1", tenant_id: "tenant-1", email_verified: 0 }]);
    });

    it("V-13: Microsoft sin mail ni UPN no crea usuario ni sesión (email_ausente)", async () => {
      microsoft({ mail: undefined });
      expect(destino(await llamar("microsoft"))).toBe("/login?error=email_ausente&proveedor=microsoft");
      expect(await usuarios()).toHaveLength(0);
      expect(cookies.set).not.toHaveBeenCalled();
    });

    it.each(["", "   "])("V-13: Google con email %j da email_ausente", async (email) => {
      google({ email });
      expect(destino(await llamar("google"))).toBe("/login?error=email_ausente&proveedor=google");
      expect(await usuarios()).toHaveLength(0);
    });

    it("Microsoft usa userPrincipalName si no hay mail", async () => {
      microsoft({ mail: undefined, userPrincipalName: "beto@corp.com" });
      await llamar("microsoft");
      expect((await usuarios())[0].email).toBe("beto@corp.com");
    });

    it("V-03: el reingreso de la misma identidad abre la misma cuenta y actualiza solo los tokens de esa identidad", async () => {
      await sembrar(ana);
      google({}, { access: "at-nuevo", refresh: "rt-nuevo" });

      const res = await llamar("google");

      expect(destino(res)).toBe("/ligas");
      expect(await usuarios()).toHaveLength(1);
      expect(await identidades()).toMatchObject([{ id: "ana", access_token: "at-nuevo", refresh_token: "rt-nuevo" }]);
      // Doble escritura (D6): users.* sigue vigente para el proveedor activo
      expect(await usuarios()).toMatchObject([{ id: "ana", access_token: "at-nuevo", refresh_token: "rt-nuevo", name: "Ana" }]);
      expect(await sesiones()).toBe(1);
    });

    it("D10: si el proveedor no reenvía el refresh token, se conserva el anterior", async () => {
      await sembrar(ana);
      google({}, { access: "at-nuevo", refresh: null });
      await llamar("google");
      expect(await identidades()).toMatchObject([{ access_token: "at-nuevo", refresh_token: "rt-ana" }]);
      expect(await usuarios()).toMatchObject([{ access_token: "at-nuevo", refresh_token: "rt-ana" }]);
    });

    it("V-11: si el email cambia en el proveedor entra a la misma cuenta; solo cambia identity.email", async () => {
      await sembrar(ana);
      google({ email: "ana.nueva@example.com" });

      expect(destino(await llamar("google"))).toBe("/ligas");

      expect(await usuarios()).toMatchObject([{ id: "ana", email: "ana@example.com" }]);
      expect(await identidades()).toMatchObject([{ id: "ana", email: "ana.nueva@example.com" }]);
    });

    it("V-05: Google verificado entra a una cuenta verificada del mismo email: se vincula y conserva ambos tokens", async () => {
      await sembrar({ ...ana, provider: "microsoft", providerId: "m-ana", verificado: true });
      google({ sub: "g-9" }, { access: "at-g", refresh: "rt-g" });

      const res = await llamar("google");

      expect(destino(res)).toBe("/ligas");
      expect(await identidades()).toMatchObject([
        { user_id: "ana", provider: "google", provider_id: "g-9", access_token: "at-g", email_verified: 1 },
        { user_id: "ana", provider: "microsoft", provider_id: "m-ana", access_token: "at-ana" },
      ]);
      // V-15: ni los tokens ni el proveedor de calendario activo cambian
      expect(await usuarios()).toMatchObject([{ id: "ana", provider: "microsoft", provider_id: "m-ana", access_token: "at-ana", refresh_token: "rt-ana" }]);
      expect(await sesiones()).toBe(1);
    });

    it("V-04: Google verificado y cuenta existente Microsoft sin verificar: email_en_uso", async () => {
      await sembrar({ ...ana, provider: "microsoft", providerId: "m-ana", verificado: false });
      google();
      expect(destino(await llamar("google"))).toBe("/login?error=email_en_uso&proveedor=microsoft");
      expect(cookies.set).not.toHaveBeenCalled();
      expect(await identidades()).toHaveLength(1);
    });

    it("V-06: Google con email_verified=false y email en uso: email_en_uso", async () => {
      await sembrar(ana);
      google({ sub: "g-9", email_verified: false });
      expect(destino(await llamar("google"))).toMatch(/^\/login\?error=email_en_uso/);
      expect(await identidades()).toHaveLength(1);
    });

    it("V-06: Google con email_verified=false y email libre: crea la cuenta sin verificar", async () => {
      google({ email_verified: false });
      expect(destino(await llamar("google"))).toBe("/ligas");
      expect(await usuarios()).toMatchObject([{ email_verified: 0 }]);
      expect(await identidades()).toMatchObject([{ email_verified: 0 }]);
    });

    it("V-06: sin el claim email_verified se trata como no verificado", async () => {
      google({ email_verified: undefined });
      await llamar("google");
      expect(await usuarios()).toMatchObject([{ email_verified: 0 }]);
    });

    it("V-14: el email se compara normalizado (mayúsculas y espacios)", async () => {
      await sembrar({ ...ana, provider: "microsoft", providerId: "m-ana" });
      google({ sub: "g-9", email: "  Ana@Example.COM " });
      expect(destino(await llamar("google"))).toBe("/ligas");
      expect(await identidades()).toHaveLength(2);
      expect(await usuarios()).toHaveLength(1);
    });

    it("V-14: el alta guarda el email normalizado", async () => {
      google({ email: "ANA@Example.com" });
      await llamar("google");
      expect(await usuarios()).toMatchObject([{ email: "ana@example.com" }]);
    });

    it("V-12: el mismo humano con dos cuentas de Microsoft (oid distinto) son identidades distintas, sin unión automática", async () => {
      await sembrar({ ...ana, provider: "microsoft", providerId: "m-personal", verificado: false });
      microsoft({ id: "m-trabajo", mail: "ana@example.com" }, { oid: "m-trabajo", tid: "tenant-trabajo" });
      expect(destino(await llamar("microsoft"))).toMatch(/^\/login\?error=email_en_uso/);
      expect(await identidades()).toHaveLength(1);
    });
  });

  describe("validaciones del callback", () => {
    it("V-16: el state de otro proveedor es invalid_state y no llama al proveedor", async () => {
      const { nombre, valor } = await cookieDeEstado({ provider: "google" });
      cookies.valores.set(nombre.replace("google", "microsoft"), valor);
      const res = await GET(
        apiCtx({
          url: "https://fisture.test/api/auth/callback/microsoft?code=c&state=st-1",
          params: { provider: "microsoft" },
          env: { ENVIRONMENT: "production", DB: t.DB, OAUTH_STATE_SECRET },
          over: { cookies, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
        })
      );
      expect(destino(res)).toBe("/login?error=invalid_state");
      expect(validar).not.toHaveBeenCalled();
    });

    it("Google sin ID token falla cerrado con oauth_failed", async () => {
      validar.mockResolvedValue(tokensFalsos({ idToken: null }));
      expect(destino(await llamar("google"))).toBe("/login?error=oauth_failed");
      expect(await usuarios()).toHaveLength(0);
    });

    it("Microsoft con un oid del ID token distinto al id de Graph falla cerrado", async () => {
      microsoft({ id: "m-1" }, { oid: "m-otro" });
      expect(destino(await llamar("microsoft"))).toBe("/login?error=oauth_failed");
      expect(await usuarios()).toHaveLength(0);
    });

    it("Microsoft con la respuesta de Graph en error falla con oauth_failed", async () => {
      validar.mockResolvedValue(tokensFalsos({ idToken: { oid: "m-1" } }));
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: {} }, { status: 403 })));
      expect(destino(await llamar("microsoft"))).toBe("/login?error=oauth_failed");
      expect(await usuarios()).toHaveLength(0);
    });
  });

  describe("fallback legado (D6)", () => {
    it("V-20: usuario sin identidad (migrado antes del deploy): se crea la identidad por provider/provider_id, no por email", async () => {
      await t.DB.prepare(
        "INSERT INTO users (id, email, email_verified, provider, provider_id, access_token, refresh_token) VALUES ('viejo', 'ana@example.com', 1, 'google', 'g-1', 'at-v', 'rt-v')"
      ).run();
      google({}, { access: "at-nuevo" });

      expect(destino(await llamar("google"))).toBe("/ligas");

      expect(await usuarios()).toHaveLength(1);
      expect(await identidades()).toMatchObject([{ id: "viejo", user_id: "viejo", provider: "google", provider_id: "g-1", access_token: "at-nuevo" }]);
    });

    it("V-20: un usuario sin identidad con el mismo email pero otro provider_id NO se reconoce por email", async () => {
      await t.DB.prepare(
        "INSERT INTO users (id, email, email_verified, provider, provider_id) VALUES ('viejo', 'ana@example.com', 1, 'google', 'g-1')"
      ).run();
      microsoft({ id: "m-evil", mail: "ana@example.com" }, { oid: "m-evil" });
      expect(destino(await llamar("microsoft"))).toMatch(/^\/login\?error=email_en_uso/);
      expect(cookies.set).not.toHaveBeenCalled();
    });
  });
});
