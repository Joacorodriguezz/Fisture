import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiCtx, silenciarConsola } from "../helpers/ctx";
import { isAdminAuthorized, unauthorized } from "../../src/lib/observability/admin-auth";

const { runSync } = vi.hoisted(() => ({ runSync: vi.fn() }));
vi.mock("../../src/lib/observability/run-sync", () => ({ runSync }));

import { POST } from "../../src/pages/api/admin/sync";

const pedido = (auth?: string) => new Request("https://fisture.test/api/admin/sync", { headers: auth ? { Authorization: auth } : {} });

describe("isAdminAuthorized", () => {
  it("acepta el Bearer con el secreto exacto", () => {
    expect(isAdminAuthorized(pedido("Bearer s3"), "s3")).toBe(true);
  });

  it.each([
    ["sin cabecera", undefined],
    ["token distinto", "Bearer otro"],
    ["más corto que el secreto", "Bearer s"],
    ["más largo que el secreto", "Bearer s3-extra"],
    ["sin el prefijo Bearer", "s3"],
    ["esquema distinto", "Basic s3"],
  ])("rechaza %s", (_caso, auth) => {
    expect(isAdminAuthorized(pedido(auth), "s3")).toBe(false);
  });

  it.each([undefined, ""])("rechaza todo si ADMIN_SECRET es %j", (secreto) => {
    expect(isAdminAuthorized(pedido("Bearer "), secreto)).toBe(false);
    expect(isAdminAuthorized(pedido("Bearer undefined"), secreto)).toBe(false);
  });

  it("unauthorized responde 401 con error JSON", async () => {
    const res = unauthorized();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });
});

describe("POST /api/admin/sync", () => {
  const env = { ADMIN_SECRET: "s3" };
  const llamar = (opts: { auth?: string; body?: unknown } = {}) =>
    POST(apiCtx({ url: "https://fisture.test/api/admin/sync", method: "POST", headers: opts.auth ? { Authorization: opts.auth } : {}, body: opts.body, env }));
  const exito = { runId: "r1", status: "success", results: [{ league: "Liga A" }], issues: [] };

  beforeEach(() => {
    silenciarConsola(vi);
    runSync.mockReset().mockResolvedValue(exito);
  });

  it("sin token responde 401 y no sincroniza", async () => {
    expect((await llamar()).status).toBe(401);
    expect(runSync).not.toHaveBeenCalled();
  });

  it("con token incorrecto responde 401 y no sincroniza", async () => {
    expect((await llamar({ auth: "Bearer otro" })).status).toBe(401);
    expect(runSync).not.toHaveBeenCalled();
  });

  it("con token correcto sincroniza todo y devuelve el resultado", async () => {
    const res = await llamar({ auth: "Bearer s3" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, ...exito });
    expect(runSync).toHaveBeenCalledWith(env, "admin", expect.objectContaining({ leagueId: undefined }));
  });

  it("pasa el leagueId del cuerpo para sincronizar una sola liga", async () => {
    await llamar({ auth: "Bearer s3", body: { leagueId: "arg.1" } });
    expect(runSync).toHaveBeenCalledWith(env, "admin", expect.objectContaining({ leagueId: "arg.1" }));
  });

  it.each([["JSON inválido", "{no es json"], ["cuerpo null", "null"]])("%s no impide sincronizar todo", async (_caso, body) => {
    const res = await llamar({ auth: "Bearer s3", body });
    expect(res.status).toBe(200);
    expect(runSync).toHaveBeenCalledWith(env, "admin", expect.objectContaining({ leagueId: undefined }));
  });

  it("un run partial sigue siendo 200 con su estado", async () => {
    runSync.mockResolvedValue({ ...exito, status: "partial" });
    const res = await llamar({ auth: "Bearer s3" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("partial");
  });

  it("un run failed con error responde 500 sin results", async () => {
    runSync.mockResolvedValue({ runId: "r2", status: "failed", error: "D1 caída", results: [], issues: [] });
    const res = await llamar({ auth: "Bearer s3" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ success: false, runId: "r2", error: "D1 caída" });
  });
});
