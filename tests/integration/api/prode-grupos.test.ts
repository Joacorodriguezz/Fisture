import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { callApi } from "../../helpers/api";
import { silenciarConsola } from "../../helpers/ctx";
import { GET as listar, POST as crear } from "../../../src/pages/api/prode/grupos/index";
import { POST as unirse } from "../../../src/pages/api/prode/grupos/unirse";
import { GET as detalle } from "../../../src/pages/api/prode/grupos/[id]";

describe("API /api/prode/grupos", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;

  beforeEach(async () => {
    silenciarConsola(vi);
    fixtures = await seedApp(t.db);
  });

  const crearComo = (user = fixtures.user, body: unknown = { nombre: "Los del barrio" }) =>
    callApi(crear, t.DB, { user, method: "POST", body });

  it("sin sesión responde 401 en los cuatro endpoints", async () => {
    expect((await callApi(listar, t.DB)).status).toBe(401);
    expect((await callApi(crear, t.DB, { method: "POST", body: { nombre: "Amigos" } })).status).toBe(401);
    expect((await callApi(unirse, t.DB, { method: "POST", body: { codigo: "x" } })).status).toBe(401);
    expect((await callApi(detalle, t.DB, { params: { id: "g" } })).status).toBe(401);
  });

  it("crea un grupo y devuelve el código de invitación", async () => {
    const res = await crearComo();
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; name: string; inviteCode: string };
    expect(body.name).toBe("Los del barrio");
    expect(body.inviteCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("un nombre inválido responde 400", async () => {
    expect((await crearComo(fixtures.user, { nombre: "a" })).status).toBe(400);
    expect((await callApi(crear, t.DB, { user: fixtures.user, method: "POST", rawBody: "{no json" })).status).toBe(400);
  });

  it("flujo completo: invitar, unirse y ver integrantes", async () => {
    const grupo = (await (await crearComo()).json()) as { id: string; inviteCode: string };

    // Antes de unirse, el ajeno recibe el mismo 404 que con un id inexistente
    const ajeno = await callApi(detalle, t.DB, { user: fixtures.other, params: { id: grupo.id } });
    const inexistente = await callApi(detalle, t.DB, { user: fixtures.other, params: { id: "no-existe" } });
    expect(ajeno.status).toBe(404);
    expect(await ajeno.json()).toEqual(await inexistente.json());

    const union = await callApi(unirse, t.DB, { user: fixtures.other, method: "POST", body: { codigo: grupo.inviteCode } });
    expect(union.status).toBe(200);
    // Idempotente
    expect((await callApi(unirse, t.DB, { user: fixtures.other, method: "POST", body: { codigo: grupo.inviteCode } })).status).toBe(200);

    const res = await callApi(detalle, t.DB, { user: fixtures.other, params: { id: grupo.id } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integrantes: unknown[]; inviteCode?: string };
    expect(body.integrantes).toHaveLength(2);
    expect(body.inviteCode).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("@");

    const mios = (await (await callApi(listar, t.DB, { user: fixtures.other })).json()) as { grupos: unknown[] };
    expect(mios.grupos).toEqual([{ id: grupo.id, name: "Los del barrio", esDueno: false, integrantes: 2 }]);
  });

  it("un código inválido responde 404", async () => {
    const res = await callApi(unirse, t.DB, { user: fixtures.other, method: "POST", body: { codigo: "A".repeat(22) } });
    expect(res.status).toBe(404);
  });
});
