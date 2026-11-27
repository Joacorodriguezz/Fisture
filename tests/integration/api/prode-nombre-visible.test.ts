// Endpoint del nombre visible del prode (tarjeta "Permitir el ingreso y elegir nombre visible").
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { callApi } from "../../helpers/api";
import { silenciarConsola } from "../../helpers/ctx";
import { GET, PUT } from "../../../src/pages/api/prode/nombre-visible";

describe("/api/prode/nombre-visible", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  relojFijo();

  beforeEach(async () => {
    silenciarConsola(vi);
    fixtures = await seedApp(t.db);
  });

  const put = (body: unknown, user = fixtures.user) => callApi(PUT, t.DB, { user, method: "PUT", body });
  const get = (user = fixtures.user) => callApi(GET, t.DB, { user });

  it("sin sesión responde 401 en GET y PUT", async () => {
    expect((await callApi(GET, t.DB)).status).toBe(401);
    expect((await callApi(PUT, t.DB, { method: "PUT", body: { nombre: "Ana" } })).status).toBe(401);
  });

  it("un usuario sin nombre elegido recibe null, no el nombre ni el email de la cuenta", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nombre: null });
  });

  it("guarda el nombre normalizado y lo devuelve en el GET siguiente", async () => {
    const res = await put({ nombre: "  La   Hormiga  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nombre: "La Hormiga" });
    expect(await (await get()).json()).toEqual({ nombre: "La Hormiga" });
  });

  it("permite editarlo", async () => {
    await put({ nombre: "Primero" });
    await put({ nombre: "Segundo" });
    expect(await (await get()).json()).toEqual({ nombre: "Segundo" });
  });

  it("solo cambia el nombre del usuario con sesión", async () => {
    await put({ nombre: "Ana10" });
    expect(await (await get(fixtures.other)).json()).toEqual({ nombre: null });
  });

  it("rechaza un nombre inválido con 400 y mensaje en español, sin guardarlo", async () => {
    const res = await put({ nombre: "ana@example.test" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "El nombre no puede incluir emails ni direcciones web.", motivo: "contacto" });
    expect(await (await get()).json()).toEqual({ nombre: null });
  });

  it("un cuerpo sin nombre o JSON inválido responde 400", async () => {
    expect((await put({})).status).toBe(400);
    expect((await callApi(PUT, t.DB, { user: fixtures.user, method: "PUT", rawBody: "{no" })).status).toBe(400);
  });

  it("nunca loguea el nombre", async () => {
    const espia = vi.spyOn(console, "log");
    const espiaInfo = vi.spyOn(console, "info");
    await put({ nombre: "NombreSecreto" });
    await put({ nombre: "x" });
    const logs = [...espia.mock.calls, ...espiaInfo.mock.calls].flat().map(String).join("\n");
    expect(logs).toContain("prode.nombre_visible.guardado");
    expect(logs).not.toContain("NombreSecreto");
  });
});
