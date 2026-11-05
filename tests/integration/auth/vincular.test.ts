// POST /api/auth/vincular/[provider]: inicia la vinculación de otro proveedor desde Configuración (docs/18 §3.2).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiCtx, silenciarConsola } from "../../helpers/ctx";
import { OAUTH_STATE_SECRET, cookiesEnMemoria, payloadDe } from "../../helpers/oauth-state";
import { POST } from "../../../src/pages/api/auth/vincular/[provider]";

const APP = "https://fisture.test";

describe("POST /api/auth/vincular/[provider]", () => {
  let cookies: ReturnType<typeof cookiesEnMemoria>;

  const env = (extra: Record<string, unknown> = {}) => ({
    ENVIRONMENT: "production",
    PUBLIC_APP_URL: APP,
    GOOGLE_CLIENT_ID: "gid",
    GOOGLE_CLIENT_SECRET: "gsecret",
    MICROSOFT_CLIENT_ID: "mid",
    MICROSOFT_CLIENT_SECRET: "msecret",
    OAUTH_STATE_SECRET,
    ...extra,
  });
  const llamar = (provider: string, opts: { user?: { id: string } | null; headers?: Record<string, string>; env?: Record<string, unknown> } = {}) =>
    POST(
      apiCtx({
        url: `${APP}/api/auth/vincular/${provider}`,
        method: "POST",
        params: { provider },
        user: "user" in opts ? opts.user : { id: "u-1" },
        headers: opts.headers,
        env: env(opts.env),
        over: { cookies, redirect: (d: string, status = 302) => new Response(null, { status, headers: { Location: d } }) },
      })
    );

  beforeEach(() => {
    silenciarConsola(vi);
    cookies = cookiesEnMemoria();
  });

  it("sin sesión responde 401 y no guarda estado", async () => {
    const res = await llamar("microsoft", { user: null });
    expect(res.status).toBe(401);
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it("un Origin de otro sitio responde 403", async () => {
    const res = await llamar("microsoft", { headers: { Origin: "https://evil.com" } });
    expect(res.status).toBe(403);
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it("un proveedor no soportado responde 400", async () => {
    expect((await llamar("github")).status).toBe(400);
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it("sin OAUTH_STATE_SECRET falla cerrado y vuelve a Configuración", async () => {
    const res = await llamar("microsoft", { env: { OAUTH_STATE_SECRET: undefined } });
    expect(res.headers.get("Location")).toBe("/configuracion?error=oauth_unavailable");
    expect(cookies.set).not.toHaveBeenCalled();
  });

  it("guarda en la cookie firmada el intent de vincular y el usuario, y redirige al proveedor (303)", async () => {
    const res = await llamar("microsoft", { headers: { Origin: APP } });

    expect(res.status).toBe(303);
    const destino = new URL(res.headers.get("Location")!);
    expect(destino.origin).toBe("https://login.microsoftonline.com");
    expect(destino.pathname).toContain("/common/oauth2/v2.0/authorize");

    const [nombre, valor, opciones] = cookies.set.mock.calls[0];
    expect(nombre).toBe("oauth_state_microsoft");
    expect(payloadDe(valor)).toMatchObject({ provider: "microsoft", intent: "link", userId: "u-1", state: destino.searchParams.get("state") });
    expect(opciones).toMatchObject({ path: "/api/auth", httpOnly: true, secure: true, sameSite: "lax" });
  });

  it("también vincula Google, con acceso offline para el calendario", async () => {
    const res = await llamar("google");
    const destino = new URL(res.headers.get("Location")!);
    expect(destino.origin).toBe("https://accounts.google.com");
    expect(destino.searchParams.get("access_type")).toBe("offline");
    expect(payloadDe(cookies.set.mock.calls[0][1])).toMatchObject({ provider: "google", intent: "link", userId: "u-1" });
  });
});
