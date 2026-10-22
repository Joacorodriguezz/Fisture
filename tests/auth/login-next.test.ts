import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "../../src/pages/api/auth/login/[provider]";

function ctx(next: string | null) {
  const guardado = new Map<string, string>();
  const url = new URL("https://fisture.test/api/auth/login/google");
  if (next !== null) url.searchParams.set("next", next);
  const env = {
    ENVIRONMENT: "production",
    PUBLIC_APP_URL: "https://fisture.test",
    GOOGLE_CLIENT_ID: "id",
    GOOGLE_CLIENT_SECRET: "secret",
    KV: { put: async (k: string, v: string) => void guardado.set(k, v) },
  };
  return {
    guardado,
    ctx: {
      request: new Request(url),
      url,
      params: { provider: "google" },
      locals: { runtime: { env } } as Record<string, any>,
      redirect: (destino: string) => new Response(null, { status: 302, headers: { Location: destino } }),
    } as any,
  };
}

const next = (guardado: Map<string, string>) => JSON.parse([...guardado.values()][0]).next;

describe("login OAuth: parámetro next", () => {
  // withApi loguea cada request por console.*: se silencia para no ensuciar la salida
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("guarda un next interno en el estado OAuth del servidor", async () => {
    const { ctx: c, guardado } = ctx("/equipos/12?lado=local");
    const res = await GET(c);
    expect(res.status).toBe(302);
    expect(next(guardado)).toBe("/equipos/12?lado=local");
  });

  it("descarta un next externo (open redirect)", async () => {
    const { ctx: c, guardado } = ctx("https://evil.com/robo");
    await GET(c);
    expect(next(guardado)).toBeNull();
  });

  it("sin next guarda null", async () => {
    const { ctx: c, guardado } = ctx(null);
    await GET(c);
    expect(next(guardado)).toBeNull();
  });
});
