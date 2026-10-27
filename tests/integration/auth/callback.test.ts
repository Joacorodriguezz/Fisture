import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { OAUTH_STATE_SECRET, cookieDeEstado, cookiesEnMemoria } from "../../helpers/oauth-state";
import { crearEstado } from "../../../src/lib/auth/oauth-state";

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
  let cookies: ReturnType<typeof cookiesEnMemoria>;
  let lecturasEnKv: string[];

  const llamar = (provider: string, query: Record<string, string>, extraEnv: Record<string, unknown> = {}) => {
    const url = new URL(`https://fisture.test/api/auth/callback/${provider}`);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    return GET(
      apiCtx({
        url: url.toString(),
        params: { provider },
        env: { ENVIRONMENT: "production", DB: t.DB, KV: kv, OAUTH_STATE_SECRET, ...extraEnv },
        over: { cookies, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );
  };
  // El intento de login vive en la cookie firmada del navegador, no en KV
  const conEstado = async (extra: { provider?: string; next?: string | null } = {}, state = "st-1") => {
    const { nombre, valor } = await cookieDeEstado({ state, ...extra });
    cookies.valores.set(nombre, valor);
  };
  const usuarios = async () => (await t.DB.prepare("SELECT * FROM users").all<any>()).results;
  const destino = (res: Response) => res.headers.get("Location");

  beforeEach(() => {
    silenciarConsola(vi);
    kv = kvEnMemoria();
    cookies = cookiesEnMemoria();
    lecturasEnKv = [];
    const get = kv.get;
    kv.get = async (k: string) => (lecturasEnKv.push(k), get(k));
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

  it("L5: sin cookie de estado redirige a invalid_state y no valida el código", async () => {
    const res = await llamar("google", { code: "c", state: "st-1" });
    expect(destino(res)).toBe("/login?error=invalid_state");
    expect(validar).not.toHaveBeenCalled();
  });

  it("L6: una cookie con la firma alterada redirige a invalid_state", async () => {
    await conEstado();
    const cookie = cookies.valores.get("oauth_state_google")!;
    cookies.valores.set("oauth_state_google", cookie.slice(0, -2) + (cookie.endsWith("AA") ? "BB" : "AA"));

    expect(destino(await llamar("google", { code: "c", state: "st-1" }))).toBe("/login?error=invalid_state");
    expect(validar).not.toHaveBeenCalled();
  });

  it("L6: una cookie firmada con otro secret redirige a invalid_state", async () => {
    const otra = await crearEstado("otro-secret-distinto-0123456789", { state: "st-1", codeVerifier: "cv", provider: "google", next: null });
    cookies.valores.set("oauth_state_google", otra);

    expect(destino(await llamar("google", { code: "c", state: "st-1" }))).toBe("/login?error=invalid_state");
    expect(validar).not.toHaveBeenCalled();
  });

  it("L7: una cookie vencida redirige a invalid_state", async () => {
    const { nombre, valor } = await cookieDeEstado({}, Date.now() - 11 * 60_000);
    cookies.valores.set(nombre, valor);

    expect(destino(await llamar("google", { code: "c", state: "st-1" }))).toBe("/login?error=invalid_state");
    expect(validar).not.toHaveBeenCalled();
  });

  it("L8: un state distinto al de la cookie redirige a invalid_state", async () => {
    await conEstado();
    expect(destino(await llamar("google", { code: "c", state: "inventado" }))).toBe("/login?error=invalid_state");
    expect(validar).not.toHaveBeenCalled();
  });

  it("L9: la cookie de Google no sirve en el callback de Microsoft", async () => {
    await conEstado();
    cookies.valores.set("oauth_state_microsoft", cookies.valores.get("oauth_state_google")!);

    expect(destino(await llamar("microsoft", { code: "c", state: "st-1" }))).toBe("/login?error=invalid_state");
    expect(validar).not.toHaveBeenCalled();
  });

  it("L10: sin OAUTH_STATE_SECRET redirige a oauth_unavailable sin validar el código", async () => {
    await conEstado();
    const res = await llamar("google", { code: "c", state: "st-1" }, { OAUTH_STATE_SECRET: undefined });
    expect(destino(res)).toBe("/login?error=oauth_unavailable");
    expect(validar).not.toHaveBeenCalled();
  });

  it("el intento es de un solo uso: se borra la cookie y el segundo callback es invalid_state", async () => {
    await conEstado();
    await llamar("google", { code: "c", state: "st-1" });
    expect(cookies.delete).toHaveBeenCalledWith("oauth_state_google", { path: "/api/auth" });
    expect(cookies.valores.has("oauth_state_google")).toBe(false);
    expect(destino(await llamar("google", { code: "c", state: "st-1" }))).toBe("/login?error=invalid_state");
  });

  it("la cookie también se consume si el proveedor rechaza el código", async () => {
    await conEstado();
    validar.mockRejectedValue(new Error("invalid_grant"));
    await llamar("google", { code: "c", state: "st-1" });
    expect(cookies.valores.has("oauth_state_google")).toBe(false);
  });

  it("L4: no lee ni escribe el estado en KV (la única escritura es la sesión)", async () => {
    await conEstado();
    const put = vi.spyOn(kv, "put");

    await llamar("google", { code: "c", state: "st-1" });

    expect(lecturasEnKv.filter((k) => k.startsWith("oauth:"))).toEqual([]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][0]).toMatch(/^session:/);
  });

  it("un proveedor no soportado redirige a unsupported_provider sin abrir sesión", async () => {
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
