import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { GET } from "../../../src/pages/api/auth/login/[provider]";

describe("login OAuth: inicio del flujo", () => {
  let kv: ReturnType<typeof kvEnMemoria>;
  let put: ReturnType<typeof vi.spyOn>;

  const env = () => ({
    ENVIRONMENT: "production",
    PUBLIC_APP_URL: "https://fisture.test",
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    MICROSOFT_CLIENT_ID: "mid",
    MICROSOFT_CLIENT_SECRET: "msecret",
    KV: kv,
  });
  const llamar = (provider: string) =>
    GET(
      apiCtx({
        url: `https://fisture.test/api/auth/login/${provider}`,
        params: { provider },
        env: env(),
        over: { redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );

  beforeEach(() => {
    silenciarConsola(vi);
    kv = kvEnMemoria();
    put = vi.spyOn(kv, "put");
  });

  it("un proveedor no soportado responde 400 y no guarda estado", async () => {
    const res = await llamar("github");
    expect(res.status).toBe(400);
    expect(put).not.toHaveBeenCalled();
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

  it("Microsoft redirige pidiendo Calendars.ReadWrite y offline_access", async () => {
    const res = await llamar("microsoft");
    const destino = new URL(res.headers.get("Location")!);

    expect(destino.host).toBe("login.microsoftonline.com");
    expect(destino.searchParams.get("redirect_uri")).toBe("https://fisture.test/api/auth/callback/microsoft");
    expect(destino.searchParams.get("scope")).toContain("Calendars.ReadWrite");
    expect(destino.searchParams.get("scope")).toContain("offline_access");
  });

  it("el state enviado al proveedor es el que queda guardado en KV, con 10 min de vida", async () => {
    const res = await llamar("google");
    const state = new URL(res.headers.get("Location")!).searchParams.get("state")!;

    expect(state).toBeTruthy();
    expect(put).toHaveBeenCalledWith(`oauth:${state}`, expect.any(String), { expirationTtl: 600 });
    expect(JSON.parse(kv.datos.get(`oauth:${state}`)!)).toMatchObject({ provider: "google", codeVerifier: expect.any(String) });
  });

  it("cada inicio de login genera un state distinto", async () => {
    const a = new URL((await llamar("google")).headers.get("Location")!).searchParams.get("state");
    const b = new URL((await llamar("google")).headers.get("Location")!).searchParams.get("state");
    expect(a).not.toBe(b);
  });
});
