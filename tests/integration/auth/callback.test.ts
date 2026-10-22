import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";

const { validar } = vi.hoisted(() => ({ validar: vi.fn() }));
vi.mock("../../../src/lib/auth/providers", () => ({
  createGoogleProvider: () => ({ validateAuthorizationCode: validar }),
  createMicrosoftProvider: () => ({ validateAuthorizationCode: validar }),
  isValidProvider: (p: string) => ["google", "microsoft"].includes(p),
}));

import { GET } from "../../../src/pages/api/auth/callback/[provider]";

const EXPIRA = new Date("2027-01-01T00:00:00Z");
const tokens = (access = "at-1") => ({
  accessToken: () => access,
  refreshToken: () => "rt-1",
  accessTokenExpiresAt: () => EXPIRA,
});
const perfilGoogle = { id: "g-1", email: "ana@example.com", name: "Ana", picture: "https://img/ana.png" };

describe("callback OAuth", () => {
  const t = useTestDb();
  let kv: ReturnType<typeof kvEnMemoria>;
  let cookies: { set: ReturnType<typeof vi.fn>; delete: ReturnType<typeof vi.fn> };

  const llamar = (provider: string, query: Record<string, string>) => {
    const url = new URL(`https://fisture.test/api/auth/callback/${provider}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return GET(
      apiCtx({
        url: url.toString(),
        params: { provider },
        env: { ENVIRONMENT: "production", DB: t.DB, KV: kv },
        over: { cookies, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );
  };
  const conEstado = (extra: Record<string, unknown> = {}, state = "st-1") =>
    kv.put(`oauth:${state}`, JSON.stringify({ codeVerifier: "cv", provider: "google", next: null, ...extra }));
  const usuarios = async () => (await t.DB.prepare("SELECT * FROM users").all<any>()).results;
  const destino = (res: Response) => res.headers.get("Location");

  beforeEach(() => {
    silenciarConsola(vi);
    kv = kvEnMemoria();
    cookies = { set: vi.fn(), delete: vi.fn() };
    validar.mockReset().mockResolvedValue(tokens());
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(perfilGoogle)));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("sin code redirige a missing_params", async () => {
    expect(destino(await llamar("google", { state: "st-1" }))).toBe("/login?error=missing_params");
  });

  it("sin state redirige a missing_params", async () => {
    expect(destino(await llamar("google", { code: "c" }))).toBe("/login?error=missing_params");
  });

  it("un state desconocido redirige a invalid_state y no valida el código", async () => {
    const res = await llamar("google", { code: "c", state: "inventado" });
    expect(destino(res)).toBe("/login?error=invalid_state");
    expect(validar).not.toHaveBeenCalled();
  });

  it("el state es de un solo uso: el segundo intento es invalid_state", async () => {
    await conEstado();
    await llamar("google", { code: "c", state: "st-1" });
    expect(kv.datos.has("oauth:st-1")).toBe(false);
    expect(destino(await llamar("google", { code: "c", state: "st-1" }))).toBe("/login?error=invalid_state");
  });

  it("un proveedor no soportado redirige a unsupported_provider sin abrir sesión", async () => {
    await conEstado();
    const res = await llamar("github", { code: "c", state: "st-1" });
    expect(destino(res)).toBe("/login?error=unsupported_provider");
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it("usuario nuevo: lo crea con sus tokens y redirige a /ligas", async () => {
    await conEstado();
    const res = await llamar("google", { code: "c", state: "st-1" });

    expect(destino(res)).toBe("/ligas");
    expect(await usuarios()).toMatchObject([
      {
        email: "ana@example.com",
        name: "Ana",
        provider: "google",
        provider_id: "g-1",
        access_token: "at-1",
        refresh_token: "rt-1",
        token_expires_at: EXPIRA.getTime(),
      },
    ]);
  });

  it("usuario nuevo: abre una sesión en KV y fija la cookie segura", async () => {
    await conEstado();
    await llamar("google", { code: "c", state: "st-1" });

    const [u] = await usuarios();
    const [nombre, sessionId, opciones] = cookies.set.mock.calls[0];
    expect(nombre).toBe("session");
    expect(kv.datos.get(`session:${sessionId}`)).toBe(u.id);
    expect(opciones).toMatchObject({ httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 2_592_000 });
  });

  it("usuario existente: no duplica y actualiza tokens y nombre", async () => {
    await conEstado();
    await llamar("google", { code: "c1", state: "st-1" });
    validar.mockResolvedValue(tokens("at-2"));
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...perfilGoogle, name: "Ana María" })));
    await conEstado({}, "st-2");

    await llamar("google", { code: "c2", state: "st-2" });

    const filas = await usuarios();
    expect(filas).toHaveLength(1);
    expect(filas[0]).toMatchObject({ name: "Ana María", access_token: "at-2" });
  });

  it("Microsoft sin mail usa userPrincipalName", async () => {
    await conEstado({ provider: "microsoft" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: "m-1", displayName: "Beto", userPrincipalName: "beto@corp.com" })));
    await llamar("microsoft", { code: "c", state: "st-1" });
    expect((await usuarios())[0]).toMatchObject({ email: "beto@corp.com", provider: "microsoft", provider_id: "m-1" });
  });

  it("Microsoft con mail lo prefiere sobre userPrincipalName", async () => {
    await conEstado({ provider: "microsoft" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: "m-1", displayName: "Beto", mail: "beto@example.com", userPrincipalName: "beto@corp.com" }))
    );
    await llamar("microsoft", { code: "c", state: "st-1" });
    expect((await usuarios())[0].email).toBe("beto@example.com");
  });

  it("respeta un next interno guardado al iniciar el login", async () => {
    await conEstado({ next: "/equipos/12?lado=local" });
    expect(destino(await llamar("google", { code: "c", state: "st-1" }))).toBe("/equipos/12?lado=local");
  });

  it.each(["https://evil.com", "//evil.com", "/login", "/api/auth/logout"])("revalida el next guardado y descarta %s", async (malo) => {
    await conEstado({ next: malo });
    expect(destino(await llamar("google", { code: "c", state: "st-1" }))).toBe("/ligas");
  });

  it("si el proveedor rechaza el código redirige a oauth_failed, sin usuario ni sesión", async () => {
    await conEstado();
    validar.mockRejectedValue(new Error("invalid_grant"));

    const res = await llamar("google", { code: "malo", state: "st-1" });

    expect(destino(res)).toBe("/login?error=oauth_failed");
    expect(await usuarios()).toHaveLength(0);
    expect(cookies.set).not.toHaveBeenCalled();
    expect([...kv.datos.keys()].filter((k) => k.startsWith("session:"))).toEqual([]);
  });
});
