// Revocación del consentimiento en el proveedor al borrar la cuenta (C6 a C8), con fetch simulado.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../../../src/lib/observability/logger";
import { revocarAcceso } from "../../../src/lib/auth/revoke";

const env = { GOOGLE_CLIENT_ID: "cid", GOOGLE_CLIENT_SECRET: "csecret", PUBLIC_APP_URL: "https://fisture.test" } as Env;
const logger = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }) satisfies Logger;

describe("revocarAcceso", () => {
  let fetchSim: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSim = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSim);
  });

  it("Google: revoca el refresh token contra el endpoint de Google", async () => {
    await revocarAcceso(env, { provider: "google", refreshToken: "rt-1" }, logger());

    expect(fetchSim).toHaveBeenCalledTimes(1);
    const req = fetchSim.mock.calls[0][0] as Request;
    expect(req.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(req.method).toBe("POST");
    expect(await req.text()).toContain("token=rt-1");
  });

  it("C6: si Google responde error no lanza y loguea provider y status, nunca el token", async () => {
    fetchSim.mockResolvedValue(new Response(null, { status: 503 }));
    const log = logger();

    await expect(revocarAcceso(env, { provider: "google", refreshToken: "rt-secreto" }, log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("account_revoke_failed", { provider: "google", status: 503 });
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("rt-secreto");
  });

  it("C6: un error OAuth de Google (400 con cuerpo) se absorbe y no se loguea el cuerpo", async () => {
    fetchSim.mockResolvedValue(new Response(JSON.stringify({ error: "invalid_token", error_description: "rt-secreto" }), { status: 400 }));
    const log = logger();

    await expect(revocarAcceso(env, { provider: "google", refreshToken: "rt-secreto" }, log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith("account_revoke_failed", { provider: "google" });
  });

  it("C6: un error de red (sin status) también se absorbe", async () => {
    fetchSim.mockRejectedValue(new TypeError("fetch failed"));
    const log = logger();

    await expect(revocarAcceso(env, { provider: "google", refreshToken: "rt-1" }, log)).resolves.toBeUndefined();

    expect(log.warn).toHaveBeenCalledWith("account_revoke_failed", { provider: "google" });
  });

  it("C7: Microsoft no intenta revocar", async () => {
    await revocarAcceso(env, { provider: "microsoft", refreshToken: "rt-1" }, logger());
    expect(fetchSim).not.toHaveBeenCalled();
  });

  it("C8: sin refresh token no intenta revocar", async () => {
    await revocarAcceso(env, { provider: "google", refreshToken: null }, logger());
    expect(fetchSim).not.toHaveBeenCalled();
  });
});
