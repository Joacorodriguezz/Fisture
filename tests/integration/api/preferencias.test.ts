// Complementa tests/integration/api.test.ts con los bordes del endpoint de preferencias.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { callApi } from "../../helpers/api";
import { silenciarConsola } from "../../helpers/ctx";
import { GET, PATCH } from "../../../src/pages/api/preferencias";

describe("PATCH /api/preferencias: bordes", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  relojFijo();

  beforeEach(async () => {
    silenciarConsola(vi);
    fixtures = await seedApp(t.db);
  });

  const patch = (body: unknown) => callApi(PATCH, t.DB, { user: fixtures.user, method: "PATCH", body });

  it("acepta los tres campos a la vez", async () => {
    const res = await patch({ reminder60: false, reminder15: false, theme: "nocturna" });
    expect(await res.json()).toEqual({ reminder60: false, reminder15: false, theme: "nocturna" });
  });

  it("ignora los campos inválidos y aplica los válidos", async () => {
    const res = await patch({ reminder60: "si", reminder15: false, theme: "rosa" });
    expect(await res.json()).toEqual({ reminder60: true, reminder15: false, theme: "papel" });
  });

  it("un campo desconocido solo responde 400 con su mensaje", async () => {
    const res = await patch({ color: "rojo" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "No valid preferences in body" });
  });

  it("un JSON inválido responde 400", async () => {
    const res = await callApi(PATCH, t.DB, { user: fixtures.user, method: "PATCH", rawBody: "{no es json" });
    expect(res.status).toBe(400);
  });

  it("el cambio queda persistido para el siguiente GET", async () => {
    await patch({ theme: "nocturna" });
    expect(await (await callApi(GET, t.DB, { user: fixtures.user })).json()).toEqual({ reminder60: true, reminder15: true, theme: "nocturna" });
  });
});
