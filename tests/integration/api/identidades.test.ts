// DELETE /api/auth/identidades/[provider]: desvincula un proveedor (docs/18 D9, V-21).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { apiCtx, silenciarConsola } from "../../helpers/ctx";

const { revocar } = vi.hoisted(() => ({ revocar: vi.fn() }));
vi.mock("../../../src/lib/auth/providers", () => ({
  createGoogleProvider: () => ({ revokeToken: revocar }),
  createMicrosoftProvider: () => ({}),
  isValidProvider: (p: string) => ["google", "microsoft"].includes(p),
}));

import { DELETE } from "../../../src/pages/api/auth/identidades/[provider]";

const APP = "https://fisture.test";

describe("DELETE /api/auth/identidades/[provider]", () => {
  const t = useTestDb();

  // Ana: cuenta de Google (proveedor de calendario activo) con Microsoft vinculado
  const sembrarAna = async (opts: { microsoft?: boolean; google?: boolean; activo?: "google" | "microsoft" } = {}) => {
    const { microsoft = true, google = true, activo = "google" } = opts;
    await t.DB.prepare("INSERT INTO users (id, email, email_verified, provider, provider_id) VALUES ('ana', 'ana@example.com', 1, ?1, 'p-1')").bind(activo).run();
    if (google) {
      await t.DB.prepare("INSERT INTO oauth_identities (id, user_id, provider, provider_id, refresh_token) VALUES ('ana', 'ana', 'google', 'g-1', 'rt-google')").run();
    }
    if (microsoft) {
      await t.DB.prepare("INSERT INTO oauth_identities (id, user_id, provider, provider_id, refresh_token) VALUES ('id-ms', 'ana', 'microsoft', 'm-1', 'rt-ms')").run();
    }
  };
  const identidades = async () => (await t.DB.prepare("SELECT provider FROM oauth_identities ORDER BY provider").all<{ provider: string }>()).results.map((i) => i.provider);

  // locals.user es la fila completa de users (la carga el middleware)
  const usuario = (id: string) => t.DB.prepare("SELECT id, provider FROM users WHERE id = ?").bind(id).first<{ id: string; provider: string }>();
  const llamar = async (provider: string, opts: { user?: { id: string } | null; headers?: Record<string, string> } = {}) =>
    DELETE(
      apiCtx({
        url: `${APP}/api/auth/identidades/${provider}`,
        method: "DELETE",
        params: { provider },
        user: "user" in opts ? (opts.user && (await usuario(opts.user.id))) : await usuario("ana"),
        headers: opts.headers,
        env: { ENVIRONMENT: "test", DB: t.DB, PUBLIC_APP_URL: APP },
      })
    );

  beforeEach(() => {
    silenciarConsola(vi);
    revocar.mockReset().mockResolvedValue(undefined);
  });

  it("sin sesión responde 401", async () => {
    await sembrarAna();
    expect((await llamar("microsoft", { user: null })).status).toBe(401);
    expect(await identidades()).toEqual(["google", "microsoft"]);
  });

  it("un Origin de otro sitio responde 403", async () => {
    await sembrarAna();
    expect((await llamar("microsoft", { headers: { Origin: "https://evil.com" } })).status).toBe(403);
    expect(await identidades()).toEqual(["google", "microsoft"]);
  });

  it("un proveedor no soportado responde 400", async () => {
    await sembrarAna();
    expect((await llamar("github")).status).toBe(400);
  });

  it("un proveedor que el usuario no tiene vinculado responde 404", async () => {
    await sembrarAna({ microsoft: false });
    expect((await llamar("microsoft")).status).toBe(404);
  });

  it("V-21: desvincula una identidad que no es la activa y no toca la otra ni la cuenta", async () => {
    await sembrarAna();
    const res = await llamar("microsoft", { headers: { Origin: APP } });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await identidades()).toEqual(["google"]);
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n).toBe(1);
  });

  it("V-21: al desvincular Google revoca su refresh token (best-effort)", async () => {
    await sembrarAna({ activo: "microsoft" });
    const res = await llamar("google");

    expect(res.status).toBe(200);
    expect(revocar).toHaveBeenCalledWith("rt-google");
    expect(await identidades()).toEqual(["microsoft"]);
  });

  it("V-21: rechaza desvincular la identidad activa del calendario", async () => {
    await sembrarAna();
    const res = await llamar("google");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "identidad_activa" });
    expect(await identidades()).toEqual(["google", "microsoft"]);
    expect(revocar).not.toHaveBeenCalled();
  });

  it("V-21: rechaza desvincular la última identidad", async () => {
    await sembrarAna({ google: false, activo: "microsoft" });
    const res = await llamar("microsoft");

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "ultima_identidad" });
    expect(await identidades()).toEqual(["microsoft"]);
  });

  it("no revela ni toca identidades de otro usuario", async () => {
    await sembrarAna();
    await t.DB.prepare("INSERT INTO users (id, email, provider, provider_id) VALUES ('beto', 'beto@corp.com', 'microsoft', 'p-9')").run();
    await t.DB.prepare("INSERT INTO oauth_identities (id, user_id, provider, provider_id) VALUES ('beto', 'beto', 'microsoft', 'm-9')").run();

    const res = await llamar("microsoft", { user: { id: "beto" } });

    expect(res.status).toBe(409); // su única identidad
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM oauth_identities").first<{ n: number }>())!.n).toBe(3);
  });

  it("si la revocación falla igual desvincula (el revoke es best-effort)", async () => {
    await sembrarAna({ activo: "microsoft" });
    revocar.mockRejectedValue(Object.assign(new Error("boom"), { status: 500 }));
    expect((await llamar("google")).status).toBe(200);
    expect(await identidades()).toEqual(["microsoft"]);
  });
});
