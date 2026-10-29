import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { OAUTH_STATE_SECRET, cookiesEnMemoria, payloadDe } from "../../helpers/oauth-state";
import { GET } from "../../../src/pages/api/auth/login/[provider]";

async function s256(verifier: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(hash))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

describe("login OAuth: inicio del flujo", () => {
  let kv: ReturnType<typeof kvEnMemoria>;
  let put: ReturnType<typeof vi.spyOn>;
  let cookies: ReturnType<typeof cookiesEnMemoria>;

  const env = (extra: Record<string, unknown> = {}) => ({
    ENVIRONMENT: "production",
    PUBLIC_APP_URL: "https://fisture.test",
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    MICROSOFT_CLIENT_ID: "mid",
    MICROSOFT_CLIENT_SECRET: "msecret",
    OAUTH_STATE_SECRET,
    KV: kv,
    ...extra,
  });
  const llamar = (provider: string, extraEnv: Record<string, unknown> = {}) =>
    GET(
      apiCtx({
        url: `https://fisture.test/api/auth/login/${provider}`,
        params: { provider },
        env: env(extraEnv),
        over: { cookies, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );

  beforeEach(() => {
    silenciarConsola(vi);
    kv = kvEnMemoria();
    put = vi.spyOn(kv, "put");
    cookies = cookiesEnMemoria();
  });

  it("un proveedor no soportado responde 400 y no guarda estado", async () => {
    const res = await llamar("github");
    expect(res.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it("Google redirige al consentimiento con acceso offline y permiso de calendario", async () => {
    const res = await llamar("google");
    const destino = new URL(res.headers.get("Location")!);

    expect(res.status).toBe(302);
    expect(destino.origin).toBe("https://accounts.google.com");
    expect(destino.searchParams.get("client_id")).toBe("gid");
    expect(destino.searchParams.get("redirect_uri")).toBe("https://fisture.test/api/auth/callback/google");
    expect(destino.searchParams.get("access_type")).toBe("offline");
    expect(destino.searchParams.get("scope")).toContain("https://www.googleapis.com/auth/calendar.events");
    expect(destino.searchParams.get("code_challenge")).toBeTruthy();
  });

  it("Microsoft redirige pidiendo Calendars.ReadWrite, offline_access y User.Read", async () => {
    const res = await llamar("microsoft");
    const destino = new URL(res.headers.get("Location")!);

    expect(destino.host).toBe("login.microsoftonline.com");
    expect(destino.searchParams.get("redirect_uri")).toBe("https://fisture.test/api/auth/callback/microsoft");
    expect(destino.searchParams.get("scope")).toContain("Calendars.ReadWrite");
    expect(destino.searchParams.get("scope")).toContain("offline_access");
    // Sin User.Read, Graph responde 403 en /me y el callback no obtiene el perfil
    expect(destino.searchParams.get("scope")?.split(" ")).toContain("User.Read");
  });

  it("L1: responde 302, no escribe en KV y deja el estado en una cookie HttpOnly", async () => {
    const res = await llamar("google");

    expect(res.status).toBe(302);
    expect(put).not.toHaveBeenCalled();
    expect(cookies.set).toHaveBeenCalledTimes(1);
    expect(cookies.opciones.get("oauth_state_google")).toEqual({
      path: "/api/auth",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      maxAge: 600,
    });
  });

  it("L2: el state y el code_challenge enviados al proveedor corresponden a la cookie", async () => {
    const res = await llamar("google");
    const destino = new URL(res.headers.get("Location")!);
    const payload = payloadDe(cookies.valores.get("oauth_state_google")!);

    expect(payload).toMatchObject({ provider: "google", next: null });
    expect(destino.searchParams.get("state")).toBe(payload.state);
    expect(destino.searchParams.get("code_challenge")).toBe(await s256(payload.codeVerifier));
  });

  it("cada proveedor usa su propia cookie, así dos intentos en paralelo no se pisan", async () => {
    await llamar("google");
    await llamar("microsoft");

    expect([...cookies.valores.keys()].sort()).toEqual(["oauth_state_google", "oauth_state_microsoft"]);
  });

  it("cada inicio de login genera un state distinto", async () => {
    const a = new URL((await llamar("google")).headers.get("Location")!).searchParams.get("state");
    const b = new URL((await llamar("google")).headers.get("Location")!).searchParams.get("state");
    expect(a).not.toBe(b);
  });

  it("L3: 100 llamadas seguidas no escriben en KV", async () => {
    for (let i = 0; i < 100; i++) await llamar(i % 2 ? "google" : "microsoft");
    expect(put).not.toHaveBeenCalled();
  });

  it("L10: sin OAUTH_STATE_SECRET falla cerrado: redirige con error, sin cookie ni KV", async () => {
    const res = await llamar("google", { OAUTH_STATE_SECRET: undefined });

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?error=oauth_unavailable");
    expect(cookies.set).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("L12: los logs no incluyen el state, el verifier ni la cookie", async () => {
    const res = await llamar("google");
    const payload = payloadDe(cookies.valores.get("oauth_state_google")!);
    expect(res.status).toBe(302);

    const salida = [console.log, console.warn, console.error]
      .flatMap((m) => vi.mocked(m).mock.calls.flat())
      .map(String)
      .join("\n");
    expect(salida.length).toBeGreaterThan(0);
    expect(salida).not.toContain(payload.state);
    expect(salida).not.toContain(payload.codeVerifier);
    expect(salida).not.toContain(cookies.valores.get("oauth_state_google")!);
  });
});
