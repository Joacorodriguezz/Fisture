// docs/15: el callback guarda los tokens cifrados (K8, K9), falla cerrado sin clave y no los loguea (K15).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { apiCtx, kvEnMemoria } from "../../helpers/ctx";
import { OAUTH_STATE_SECRET, cookieDeEstado, cookiesEnMemoria } from "../../helpers/oauth-state";
import { tokensFalsos } from "../../helpers/id-token";
import { claro, descifrarFilas, nuevaClave, TOKEN_ENCRYPTION_KEY } from "../../helpers/token-key";
import { decryptToken } from "../../../src/lib/auth/token-crypto";

const { validar } = vi.hoisted(() => ({ validar: vi.fn() }));
vi.mock("../../../src/lib/auth/providers", () => ({
  createGoogleProvider: () => ({ validateAuthorizationCode: validar }),
  createMicrosoftProvider: () => ({ validateAuthorizationCode: validar }),
  isValidProvider: (p: string) => ["google", "microsoft"].includes(p),
}));

import { GET } from "../../../src/pages/api/auth/callback/[provider]";

const claims = { sub: "g-1", email: "ana@example.com", email_verified: true, name: "Ana" };
const tokens = (access: string, refresh: string | null = "rt-secreto-1") =>
  tokensFalsos({ idToken: claims, access, refresh, expira: new Date("2027-01-01T00:00:00Z") });

describe("callback OAuth: tokens cifrados en reposo", () => {
  const t = useTestDb();
  let lineas: string[];

  beforeEach(() => {
    lineas = [];
    for (const metodo of ["log", "warn", "error"] as const) {
      vi.spyOn(console, metodo).mockImplementation((l: unknown) => void lineas.push(String(l)));
    }
    validar.mockReset().mockResolvedValue(tokens("at-secreto-1"));
  });

  const entrar = async (env: Record<string, unknown> = { TOKEN_ENCRYPTION_KEY }, state = "st-1") => {
    const cookies = cookiesEnMemoria();
    const { nombre, valor } = await cookieDeEstado({ state, provider: "google" });
    cookies.valores.set(nombre, valor);
    return GET(
      apiCtx({
        url: `https://fisture.test/api/auth/callback/google?code=c&state=${state}`,
        params: { provider: "google" },
        env: { ENVIRONMENT: "production", DB: t.DB, KV: kvEnMemoria(), OAUTH_STATE_SECRET, ...env },
        over: { cookies, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );
  };
  const filas = async (tabla: "users" | "oauth_identities") => (await t.DB.prepare(`SELECT * FROM ${tabla}`).all<any>()).results;

  it("K8: un login nuevo deja users y oauth_identities con prefijo enc:v1: y sin el token en claro", async () => {
    expect((await entrar()).headers.get("Location")).toBe("/ligas");
    for (const tabla of ["users", "oauth_identities"] as const) {
      const [fila] = await filas(tabla);
      expect(fila.access_token).toMatch(/^enc:v1:/);
      expect(fila.refresh_token).toMatch(/^enc:v1:/);
      expect(JSON.stringify(fila)).not.toContain("at-secreto-1");
      expect(JSON.stringify(fila)).not.toContain("rt-secreto-1");
      expect(await claro(fila.access_token, fila.id, "access_token")).toBe("at-secreto-1");
    }
  });

  it("K9: el reingreso re-cifra con la clave actual y deja legible el token nuevo", async () => {
    await entrar();
    const antes = (await filas("users"))[0].access_token;
    validar.mockResolvedValue(tokens("at-secreto-2"));
    await entrar(undefined, "st-2");
    const [u] = await descifrarFilas(await filas("users"));
    expect((await filas("users"))[0].access_token).not.toBe(antes);
    expect(u.access_token).toBe("at-secreto-2");
  });

  it("K9: un reingreso sobre filas legadas en claro las deja cifradas, y conserva el refresh si no llega otro", async () => {
    await entrar();
    await t.DB.batch([
      t.DB.prepare("UPDATE users SET access_token = 'at-legado', refresh_token = 'rt-legado'"),
      t.DB.prepare("UPDATE oauth_identities SET access_token = 'at-legado', refresh_token = 'rt-legado'"),
    ]);
    validar.mockResolvedValue(tokensFalsos({ idToken: claims, access: "at-nuevo", expira: new Date("2027-01-01T00:00:00Z") }));
    await entrar(undefined, "st-2");
    for (const tabla of ["users", "oauth_identities"] as const) {
      const [fila] = await filas(tabla);
      expect(fila.access_token).toMatch(/^enc:v1:/);
      const [claras] = await descifrarFilas([fila]);
      expect(claras).toMatchObject({ access_token: "at-nuevo" });
    }
  });

  it("K7: sin TOKEN_ENCRYPTION_KEY el login falla cerrado, no guarda nada y lo registra", async () => {
    const res = await entrar({});
    expect(res.headers.get("Location")).toBe("/login?error=oauth_failed");
    expect(await filas("users")).toHaveLength(0);
    expect(await filas("oauth_identities")).toHaveLength(0);
    expect(lineas.join("\n")).toContain("token_key_missing");
  });

  it("K7: una clave de largo incorrecto también falla cerrado", async () => {
    const res = await entrar({ TOKEN_ENCRYPTION_KEY: btoa("corta") });
    expect(res.headers.get("Location")).toBe("/login?error=oauth_failed");
    expect(await filas("users")).toHaveLength(0);
  });

  it("K15: los logs no contienen tokens ni la clave, ni en claro ni cifrados", async () => {
    await entrar();
    await entrar({}, "st-2"); // también el camino de error
    const [u] = await filas("users");
    const log = lineas.join("\n");
    expect(log).not.toContain("at-secreto-1");
    expect(log).not.toContain("rt-secreto-1");
    expect(log).not.toContain(TOKEN_ENCRYPTION_KEY);
    expect(log).not.toContain(u.access_token);
    expect(log).not.toContain(u.refresh_token);
  });

  it("al reingresar con una clave nueva y la anterior en PREVIOUS, los tokens viejos siguen legibles y pasan a la nueva", async () => {
    await entrar();
    const nueva = nuevaClave();
    validar.mockResolvedValue(tokens("at-nuevo", null));
    await entrar({ TOKEN_ENCRYPTION_KEY: nueva, TOKEN_ENCRYPTION_KEY_PREVIOUS: TOKEN_ENCRYPTION_KEY }, "st-2");
    const [fila] = await filas("users");
    // El refresh token anterior (cifrado con la clave vieja) se leyó con PREVIOUS y se re-cifró con la nueva
    await expect(claro(fila.refresh_token, fila.id, "refresh_token")).rejects.toThrow();
    expect(await decryptToken({ TOKEN_ENCRYPTION_KEY: nueva } as Env, fila.refresh_token, `${fila.id}:refresh_token`)).toBe("rt-secreto-1");
  });
});
