import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/d1";
import { seedApp } from "../helpers/fixtures";
import { callApi } from "../helpers/api";
import { calendarHttp } from "../helpers/calendar-http";
import { createDb } from "../../src/lib/db";
import { calendarSyncs, matches } from "../../drizzle/schema";
import { POST, DELETE } from "../../src/pages/api/calendario/sync";

describe("API del calendario con servicio, clientes y D1 reales", () => {
  let t: TestDb;
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  let http: ReturnType<typeof calendarHttp>;
  beforeEach(async () => {
    t = await createTestDb(); fixtures = await seedApp(createDb(t.DB));
    http = calendarHttp(); vi.stubGlobal("fetch", http.fetch);
  });
  afterEach(async () => { await t?.dispose(); });

  it("rechaza requests anónimas y payloads inválidos con 400 sin llamar al proveedor", async () => {
    expect((await callApi(POST, t.DB, { method: "POST", body: { matchId: "superclasico" } })).status).toBe(401);
    expect((await callApi(DELETE, t.DB, { method: "DELETE" })).status).toBe(401);
    for (const body of [null, [], "invalid", {}, { matchId: 1 }, { matchIds: "superclasico" }, { matchIds: [null] }, { matchIds: [] }, { matchIds: [" "] }]) {
      expect((await callApi(POST, t.DB, { user: fixtures.user, method: "POST", body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await callApi(POST, t.DB, { user: fixtures.user, method: "POST", rawBody: "{invalid" })).status).toBe(400);
    expect(http.requests).toHaveLength(0);
    expect(await createDb(t.DB).select().from(calendarSyncs)).toHaveLength(0);
  });

  it("devuelve 200 en duplicados y 207 en lotes parciales con identificador de request", async () => {
    const duplicate = await callApi(POST, t.DB, { user: fixtures.user, method: "POST", body: { matchIds: ["superclasico", "superclasico"] } });
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual({ success: true, results: [{ matchId: "superclasico", success: true }] });
    expect(duplicate.headers.get("x-request-id")).toBeTruthy();
    const partial = await callApi(POST, t.DB, { user: fixtures.user, method: "POST", body: { matchIds: ["superclasico", "missing"] } });
    expect(partial.status).toBe(207);
    expect(await partial.json()).toMatchObject({ success: false, results: [{ matchId: "superclasico", success: true }, { matchId: "missing", success: false }] });
    expect(http.events.size).toBe(1);
  });

  it("un fallo de auth corta la tanda sin guardar filas failed", async () => {
    const response = await callApi(POST, t.DB, { user: { ...fixtures.user, accessToken: null }, method: "POST", body: { matchIds: ["superclasico", "missing"] } });
    expect(response.status).toBe(207);
    const body = await response.json();
    expect(body.results).toHaveLength(2);
    expect(body.results.every((result: { code: string }) => result.code === "auth")).toBe(true);
    expect(await createDb(t.DB).select().from(calendarSyncs)).toEqual([]);
    expect(http.requests).toHaveLength(0);
  });

  it("no elimina eventos de otro usuario y deja una eliminación fallida recuperable", async () => {
    await callApi(POST, t.DB, { user: fixtures.user, method: "POST", body: { matchId: "superclasico" } });
    expect((await callApi(DELETE, t.DB, { user: fixtures.user, method: "DELETE" })).status).toBe(400);
    expect((await callApi(DELETE, t.DB, { user: fixtures.other, method: "DELETE", path: "/api/calendario/sync?matchId=superclasico" })).status).toBe(200);
    expect(http.events.size).toBe(1);
    http.failures.push({ method: "DELETE", status: 503, message: "Try later" });
    expect((await callApi(DELETE, t.DB, { user: fixtures.user, method: "DELETE", path: "/api/calendario/sync?matchId=superclasico" })).status).toBe(500);
    expect(await createDb(t.DB).select().from(calendarSyncs)).toHaveLength(1);
    expect((await callApi(DELETE, t.DB, { user: fixtures.user, method: "DELETE", path: "/api/calendario/sync?matchId=superclasico" })).status).toBe(200);
    expect(http.events.size).toBe(0);
  });

  it("un partido cancelado sin evento previo devuelve error sin crearlo", async () => {
    await createDb(t.DB).update(matches).set({ status: "cancelled" });
    const response = await callApi(POST, t.DB, { user: fixtures.user, method: "POST", body: { matchId: "superclasico" } });
    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({ success: false, results: [{ error: "El partido está cancelado" }] });
    expect(http.events.size).toBe(0);
  });
});
