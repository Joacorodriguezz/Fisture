import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../../src/pages/api/auth/login/[provider]";
import { OAUTH_STATE_SECRET, cookiesEnMemoria, payloadDe } from "../../helpers/oauth-state";

function ctx(next: string | null) {
  const cookies = cookiesEnMemoria();
  const url = new URL("https://fisture.test/api/auth/login/google");
  if (next !== null) url.searchParams.set("next", next);
  const env = {
    ENVIRONMENT: "production",
    PUBLIC_APP_URL: "https://fisture.test",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    OAUTH_STATE_SECRET,
  };
  return {
    cookies,
    ctx: {
      request: new Request(url),
      url,
      params: { provider: "google" },
      cookies,
      locals: { runtime: { env } } as Record<string, any>,
      redirect: (destino: string) => new Response(null, { status: 302, headers: { Location: destino } }),
    } as any,
  };
}

const next = (cookies: ReturnType<typeof cookiesEnMemoria>) => payloadDe(cookies.valores.get("oauth_state_google")!).next;

describe("login OAuth: parámetro next", () => {
  // withApi loguea cada request por console.*: se silencia para no ensuciar la salida
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("guarda un next interno en el estado OAuth firmado", async () => {
    const { ctx: c, cookies } = ctx("/equipos/12?lado=local");
    const res = await GET(c);
    expect(res.status).toBe(302);
    expect(next(cookies)).toBe("/equipos/12?lado=local");
  });

  it("L11: descarta un next externo (open redirect)", async () => {
    const { ctx: c, cookies } = ctx("https://evil.com/robo");
    await GET(c);
    expect(next(cookies)).toBeNull();
  });

  it("L11: descarta un next con doble barra", async () => {
    const { ctx: c, cookies } = ctx("//evil.com");
    await GET(c);
    expect(next(cookies)).toBeNull();
  });

  it("sin next guarda null", async () => {
    const { ctx: c, cookies } = ctx(null);
    await GET(c);
    expect(next(cookies)).toBeNull();
  });
});
