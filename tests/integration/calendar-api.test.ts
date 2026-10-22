import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { relojFijo } from "../helpers/clock";
import { seedApp } from "../helpers/fixtures";
import { callApi } from "../helpers/api";
import { calendarHttp } from "../helpers/calendar-http";
import { calendarSyncs, matches } from "../../drizzle/schema";
import { POST, DELETE } from "../../src/pages/api/calendario/sync";

describe("API del calendario con servicio, clientes y D1 reales", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  let http: ReturnType<typeof calendarHttp>;
  relojFijo();
  beforeEach(async () => {
    fixtures = await seedApp(t.db);
    http = calendarHttp();
    vi.stubGlobal("fetch", http.fetch);
  });

  const agregar = (body: unknown, user = fixtures.user) => callApi(POST, t.DB, { user, method: "POST", body });
  const quitar = (matchId?: string, user: typeof fixtures.user | null = fixtures.user) =>
    callApi(DELETE, t.DB, { user: user ?? undefined, method: "DELETE", path: `/api/calendario/sync${matchId ? `?matchId=${matchId}` : ""}` });
  const filasSync = () => t.db.select().from(calendarSyncs);

  describe("POST: validación", () => {
    it("rechaza requests anónimas", async () => {
      expect((await callApi(POST, t.DB, { method: "POST", body: { matchId: "superclasico" } })).status).toBe(401);
      expect((await quitar("superclasico", null)).status).toBe(401);
    });

    it.each([
      ["null", null],
      ["arreglo", []],
      ["string", "invalid"],
      ["objeto vacío", {}],
      ["matchId numérico", { matchId: 1 }],
      ["matchIds que no es arreglo", { matchIds: "superclasico" }],
      ["matchIds con null", { matchIds: [null] }],
      ["matchIds vacío", { matchIds: [] }],
      ["matchIds con un id en blanco", { matchIds: [" "] }],
    ])("un cuerpo inválido (%s) responde 400 sin llamar al proveedor ni escribir en D1", async (_caso, body) => {
      expect((await agregar(body)).status).toBe(400);
      expect(http.requests).toHaveLength(0);
      expect(await filasSync()).toHaveLength(0);
    });

    it("un JSON malformado responde 400", async () => {
      expect((await callApi(POST, t.DB, { user: fixtures.user, method: "POST", rawBody: "{invalid" })).status).toBe(400);
    });
  });

  describe("POST: resultados", () => {
    it("ids duplicados se procesan una vez y responden 200 con identificador de request", async () => {
      const res = await agregar({ matchIds: ["superclasico", "superclasico"] });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, results: [{ matchId: "superclasico", success: true }] });
      expect(res.headers.get("x-request-id")).toBeTruthy();
    });

    it("un lote parcial responde 207 y detalla qué partido falló", async () => {
      const res = await agregar({ matchIds: ["superclasico", "missing"] });
      expect(res.status).toBe(207);
      expect(await res.json()).toMatchObject({ success: false, results: [{ matchId: "superclasico", success: true }, { matchId: "missing", success: false }] });
      expect(http.events.size).toBe(1);
    });

    it("un fallo de autenticación corta la tanda sin llamar al proveedor ni guardar filas failed", async () => {
      const res = await agregar({ matchIds: ["superclasico", "missing"] }, { ...fixtures.user, accessToken: null });
      const body = await res.json();

      expect(res.status).toBe(207);
      expect(body.results).toHaveLength(2);
      expect(body.results.every((r: { code: string }) => r.code === "auth")).toBe(true);
      expect(await filasSync()).toEqual([]);
      expect(http.requests).toHaveLength(0);
    });

    it("un partido cancelado sin evento previo devuelve error sin crearlo", async () => {
      await t.db.update(matches).set({ status: "cancelled" });
      const res = await agregar({ matchId: "superclasico" });
      expect(res.status).toBe(207);
      expect(await res.json()).toMatchObject({ success: false, results: [{ error: "El partido está cancelado" }] });
      expect(http.events.size).toBe(0);
    });
  });

  describe("DELETE", () => {
    beforeEach(async () => {
      await agregar({ matchId: "superclasico" });
    });

    it("sin matchId responde 400", async () => {
      expect((await quitar()).status).toBe(400);
    });

    it("otro usuario no elimina el evento ajeno", async () => {
      expect((await quitar("superclasico", fixtures.other)).status).toBe(200);
      expect(http.events.size).toBe(1);
    });

    it("quitar el partido borra el evento y la fila", async () => {
      expect((await quitar("superclasico")).status).toBe(200);
      expect(http.events.size).toBe(0);
      expect(await filasSync()).toHaveLength(0);
    });

    it("si el proveedor falla al borrar responde 500 y conserva la fila para reintentar", async () => {
      http.failures.push({ method: "DELETE", status: 503, message: "Try later", match: /\/events\// });
      expect((await quitar("superclasico")).status).toBe(500);
      expect(await filasSync()).toHaveLength(1);
    });

    it("el reintento tras un borrado fallido elimina el evento", async () => {
      http.failures.push({ method: "DELETE", status: 503, message: "Try later", match: /\/events\// });
      await quitar("superclasico");
      expect((await quitar("superclasico")).status).toBe(200);
      expect(http.events.size).toBe(0);
    });
  });
});
