import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/d1";
import { clienteFalso, fila, filas, getToken, insertarSync, sembrar, setMatch, T0, usuario } from "../helpers/calendar";
import { createDb, type Database } from "../../src/lib/db";
import { syncMatches } from "../../src/lib/calendar/sync-service";
import { CalendarApiError } from "../../src/lib/calendar/errors";

describe("syncMatches", () => {
  let t: TestDb;
  let db: Database;
  let falso: ReturnType<typeof clienteFalso>;

  const env = {} as Env;
  const sync = async (ids: string[], mode: "auto" | "manual" = "manual", userId = "u1") =>
    syncMatches(db, env, await usuario(db, userId), ids, { mode, deps: { client: falso.client, getToken } });

  beforeAll(async () => {
    t = await createTestDb();
    db = createDb(t.DB);
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    await sembrar(t);
    falso = clienteFalso();
  });

  describe("agregar un partido (casos 'ya tengo un evento')", () => {
    it("crea el evento y guarda el estado sincronizado", async () => {
      const [r] = await sync(["m1"]);
      expect(r.success).toBe(true);
      expect(falso.llamadas.create).toBe(1);
      expect(await fila(t, "m1")).toMatchObject({
        status: "synced",
        external_event_id: "ev-u1-m1",
        synced_date_time: T0,
        synced_state: "scheduled",
        synced_venue: "Cancha",
      });
    });

    it("A1: si ya está synced y al día no llama a la API", async () => {
      await sync(["m1"]);
      const antes = falso.total();
      const [r] = await sync(["m1"]);
      expect(r.success).toBe(true);
      expect(falso.total()).toBe(antes);
    });

    it("A2: dos requests concurrentes dejan un solo evento y una sola fila", async () => {
      await Promise.all([sync(["m1"]), sync(["m1"])]);
      expect(falso.eventos.size).toBe(1);
      expect(await filas(t, "match_id = 'm1'")).toHaveLength(1);
    });

    it("A3: sin fila pero con el evento ya en el calendario se adopta ese mismo evento", async () => {
      falso.eventos.set("ev-u1-m1", { title: "viejo", start: 0 }); // el create del cliente real adopta y devuelve el id existente
      await sync(["m1"]);
      expect(falso.eventos.size).toBe(1);
      expect((await fila(t, "m1")).external_event_id).toBe("ev-u1-m1");
    });

    it("A8: un id repetido se procesa una sola vez", async () => {
      const r = await sync(["m1", "m1"]);
      expect(r).toHaveLength(1);
      expect(falso.llamadas.create).toBe(1);
    });

    it("partido inexistente: falla ese y sigue con el resto", async () => {
      const r = await sync(["nope", "m1"]);
      expect(r.map((x) => x.success)).toEqual([false, true]);
    });

    it("C5: un error permanente en un partido no frena a los demás", async () => {
      let n = 0;
      falso.fallos.create = () => (++n === 1 ? new CalendarApiError("datos inválidos", 400) : null);
      const r = await sync(["m1", "m2", "m3"]);
      expect(r.map((x) => x.success)).toEqual([false, true, true]);
      expect((await fila(t, "m1")).status).toBe("failed");
    });
  });

  describe("A4: el usuario borró el evento", () => {
    beforeEach(async () => {
      await insertarSync(t, { id: "s1", match: "m1", event: "ev-u1-m1" });
      await setMatch(t, "m1", { dateTime: T0 + 3600 }); // reprogramado
      falso.fallos.update = () => new CalendarApiError("not found", 404);
    });

    it("en modo auto queda detached y no se recrea", async () => {
      await sync(["m1"], "auto");
      expect(falso.llamadas.create).toBe(0);
      expect(await fila(t, "m1")).toMatchObject({ status: "detached", external_event_id: null });
    });

    it("el cron no vuelve a tocar un detached", async () => {
      await sync(["m1"], "auto");
      const antes = falso.total();
      await sync(["m1"], "auto");
      expect(falso.total()).toBe(antes);
    });

    it("un clic manual sí lo recrea", async () => {
      await sync(["m1"], "manual");
      expect(falso.llamadas.create).toBe(1);
      expect(await fila(t, "m1")).toMatchObject({ status: "synced", external_event_id: "ev-u1-m1" });
    });

    it("manual sobre un detached ya marcado también lo recrea", async () => {
      await sync(["m1"], "auto");
      falso.fallos.update = undefined;
      await sync(["m1"], "manual");
      expect(falso.llamadas.create).toBe(1);
      expect((await fila(t, "m1")).status).toBe("synced");
    });
  });

  describe("A6: eventos ajenos superpuestos", () => {
    const choque = [{ title: "Reunión", start: "2027-01-15T08:00:00Z", end: "2027-01-15T09:00:00Z" }];

    it("se agrega igual y se devuelve el aviso", async () => {
      falso.setSolapados(choque);
      const [r] = await sync(["m1"]);
      expect(r.success).toBe(true);
      expect(r.warnings).toEqual([{ code: "overlap", count: 1, items: choque }]);
    });

    it("no se consulta en lotes ni en modo auto", async () => {
      falso.setSolapados(choque);
      await sync(["m1", "m2"]);
      await sync(["m3"], "auto");
      expect(falso.llamadas.overlaps).toBe(0);
    });

    it("si la consulta de solapamientos falla, el partido igual queda agregado", async () => {
      falso.client.overlaps = async () => {
        throw new Error("boom");
      };
      const [r] = await sync(["m1"]);
      expect(r.success).toBe(true);
      expect(r.warnings).toBeUndefined();
    });
  });

  describe("reprogramaciones", () => {
    beforeEach(async () => {
      await insertarSync(t, { id: "s1", match: "m1", event: "ev-u1-m1", status: "needs_update" });
      falso.eventos.set("ev-u1-m1", { title: "Equipo t1 vs Equipo t2", start: T0 * 1000 });
    });

    it("B1: cambia la hora → update (no create) y guarda la nueva fecha", async () => {
      await setMatch(t, "m1", { dateTime: T0 + 7200 });
      await sync(["m1"]);
      expect(falso.llamadas).toMatchObject({ update: 1, create: 0 });
      expect(await fila(t, "m1")).toMatchObject({ status: "synced", external_event_id: "ev-u1-m1", synced_date_time: T0 + 7200 });
    });

    it("B2: cambia la sede → update", async () => {
      await setMatch(t, "m1", { venue: "Monumental" });
      await sync(["m1"]);
      expect(falso.llamadas.update).toBe(1);
      expect((await fila(t, "m1")).synced_venue).toBe("Monumental");
    });

    it("B10: cambian hora y sede a la vez → una sola llamada", async () => {
      await setMatch(t, "m1", { dateTime: T0 + 60, venue: "Otra" });
      await sync(["m1"]);
      expect(falso.total()).toBe(1);
    });

    it("B12: sin cambios no llama a la API", async () => {
      await t.DB.prepare("UPDATE calendar_syncs SET status = 'synced'").run();
      await sync(["m1"]);
      expect(falso.total()).toBe(0);
    });

    it("B3: postergado → título con prefijo y sin cambiar el horario", async () => {
      await setMatch(t, "m1", { status: "postponed" });
      await sync(["m1"]);
      expect(falso.eventos.get("ev-u1-m1")?.title).toBe("[POSTERGADO] Equipo t1 vs Equipo t2");
      expect(falso.eventos.get("ev-u1-m1")?.start).toBe(T0 * 1000);
      expect((await fila(t, "m1")).synced_state).toBe("postponed");
    });

    it("B4: postergado que recibe fecha nueva → hora nueva y sin prefijo", async () => {
      await setMatch(t, "m1", { status: "postponed" });
      await sync(["m1"]);
      await setMatch(t, "m1", { status: "scheduled", dateTime: T0 + 86400 });
      await t.DB.prepare("UPDATE calendar_syncs SET status = 'needs_update'").run();
      await sync(["m1"]);
      expect(falso.eventos.get("ev-u1-m1")).toEqual({ title: "Equipo t1 vs Equipo t2", start: (T0 + 86400) * 1000 });
      expect((await fila(t, "m1")).synced_state).toBe("scheduled");
    });
  });

  describe("cancelados", () => {
    beforeEach(async () => {
      await insertarSync(t, { id: "s1", match: "m1", event: "ev-u1-m1", status: "needs_update" });
      falso.eventos.set("ev-u1-m1", { title: "x", start: 0 });
      await setMatch(t, "m1", { status: "cancelled" });
    });

    it("B5: se borra el evento y la fila queda cancelled sin id externo", async () => {
      await sync(["m1"]);
      expect(falso.eventos.size).toBe(0);
      expect(await fila(t, "m1")).toMatchObject({ status: "cancelled", external_event_id: null, synced_state: "cancelled" });
    });

    it("B5: si el evento ya no existe (404 al borrar) igual queda cancelled", async () => {
      falso.fallos.remove = () => new CalendarApiError("gone", 404);
      await sync(["m1"]);
      expect((await fila(t, "m1")).status).toBe("cancelled");
    });

    it("un cancelled ya procesado no vuelve a llamar a la API", async () => {
      await sync(["m1"]);
      const antes = falso.total();
      await sync(["m1"]);
      expect(falso.total()).toBe(antes);
    });

    it("B6: si el partido vuelve a scheduled se crea de nuevo", async () => {
      await sync(["m1"]);
      await setMatch(t, "m1", { status: "scheduled" });
      await t.DB.prepare("UPDATE calendar_syncs SET status = 'needs_update'").run();
      await sync(["m1"]);
      expect(falso.llamadas.create).toBe(1);
      expect(await fila(t, "m1")).toMatchObject({ status: "synced", external_event_id: "ev-u1-m1" });
    });

    it("agregar a mano un partido cancelado que no estaba en el calendario no crea nada", async () => {
      await t.DB.prepare("DELETE FROM calendar_syncs").run();
      const [r] = await sync(["m1"]);
      expect(r.success).toBe(false);
      expect(falso.total()).toBe(0);
    });
  });

  describe("errores del proveedor al actualizar", () => {
    beforeEach(async () => {
      await insertarSync(t, { id: "s1", match: "m1", event: "ev-u1-m1", status: "needs_update" });
      await setMatch(t, "m1", { dateTime: T0 + 60 });
    });

    it.each([
      ["5xx", () => new CalendarApiError("backend", 503)],
      ["red", () => new TypeError("fetch failed")],
    ])("G1: %s → failed, conserva el id y NO crea un evento nuevo", async (_n, error) => {
      falso.fallos.update = error;
      const [r] = await sync(["m1"]);
      expect(r.success).toBe(false);
      expect(falso.llamadas.create).toBe(0);
      expect(await fila(t, "m1")).toMatchObject({ status: "failed", external_event_id: "ev-u1-m1" });
    });

    it("G9: un error de autenticación corta el bucle, no crea nada y no marca failed", async () => {
      await t.DB.prepare("INSERT INTO calendar_syncs (id, user_id, match_id, provider, status) VALUES ('s2','u1','m2','google','pending')").run();
      falso.fallos.update = () => new CalendarApiError("unauthorized", 401);
      const r = await sync(["m1", "m2", "m3"]);
      expect(r.map((x) => x.success)).toEqual([false, false, false]);
      expect(r.every((x) => x.code === "auth")).toBe(true);
      expect(falso.llamadas.update).toBe(1);
      expect(falso.llamadas.create).toBe(0);
      expect((await fila(t, "m1")).status).toBe("needs_update");
      expect((await fila(t, "m2")).status).toBe("pending");
    });

    it("un token que no se puede obtener también es auth y no toca el estado", async () => {
      const [r] = await syncMatches(db, env, await usuario(db), ["m1"], {
        mode: "manual",
        deps: {
          client: falso.client,
          getToken: async () => {
            throw new Error("No calendar access token");
          },
        },
      });
      expect(r).toMatchObject({ success: false, code: "auth" });
      expect((await fila(t, "m1")).status).toBe("needs_update");
    });

    it("429 corta el bucle sin marcar failed", async () => {
      falso.fallos.update = () => new CalendarApiError("rate", 429, { retryAfter: 30 });
      const r = await sync(["m1", "m2"]);
      expect(r.every((x) => x.code === "rate_limit")).toBe(true);
      expect(falso.llamadas.update).toBe(1);
      expect((await fila(t, "m1")).status).toBe("needs_update");
    });
  });
});
