import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../helpers/d1";
import { clienteFalso, fila, getToken, insertarSync, sembrar, setMatch, T0 } from "../../helpers/calendar";
import { createDb, type Database } from "../../../src/lib/db";
import { reconcileCalendars } from "../../../src/lib/calendar/sync-service";
import { CalendarApiError } from "../../../src/lib/calendar/errors";

const AHORA = new Date((T0 - 86_400) * 1000);

describe("reconcileCalendars", () => {
  let t: TestDb;
  let db: Database;
  let falso: ReturnType<typeof clienteFalso>;

  const reconciliar = (limites?: { maxUsers?: number; matchesPerUser?: number }) =>
    reconcileCalendars({} as Env, db, { client: falso.client, getToken }, { now: AHORA, ...limites });

  const seguir = (userId: string, teamId = "t1") =>
    t.DB.prepare("INSERT INTO user_teams (id, user_id, team_id, auto_sync) VALUES (?, ?, ?, 1)").bind(`ut-${userId}`, userId, teamId).run();

  beforeAll(async () => {
    t = await createTestDb();
    db = createDb(t.DB);
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    await sembrar(t, ["m1", "m2", "m3", "m4"]);
    falso = clienteFalso();
  });

  it("B8: un usuario sin auto-sync con un evento manual reprogramado se corrige igual", async () => {
    await insertarSync(t, { id: "s1", match: "m1" });
    await setMatch(t, "m1", { dateTime: T0 + 3600 });
    await reconciliar();
    expect(falso.llamadas.update).toBe(1);
    expect(await fila(t, "m1")).toMatchObject({ status: "synced", synced_date_time: T0 + 3600 });
  });

  it("detecta la reprogramación sin pasar por una vista de página (markOutdated global)", async () => {
    await insertarSync(t, { id: "s1", match: "m1", user: "u1" });
    await insertarSync(t, { id: "s2", match: "m1", user: "u2" });
    await setMatch(t, "m1", { venue: "Otra cancha" });
    await reconciliar();
    expect(falso.llamadas.update).toBe(2);
  });

  it("un usuario con auto-sync recibe también los partidos nuevos de su equipo", async () => {
    await seguir("u1");
    await reconciliar();
    expect(falso.llamadas.create).toBe(4);
  });

  it("no recrea lo que el usuario borró: queda detached", async () => {
    await insertarSync(t, { id: "s1", match: "m1" });
    await setMatch(t, "m1", { dateTime: T0 + 60 });
    falso.fallos.update = () => new CalendarApiError("gone", 410);
    await reconciliar();
    expect(falso.llamadas.create).toBe(0);
    expect((await fila(t, "m1")).status).toBe("detached");
  });

  it("no reofrece los partidos detached ni los cancelled del auto-sync", async () => {
    await seguir("u1");
    await insertarSync(t, { id: "s1", match: "m1", status: "detached", event: null });
    await insertarSync(t, { id: "s2", match: "m2", status: "cancelled", event: null, state: "cancelled" });
    await setMatch(t, "m2", { status: "cancelled" });
    await reconciliar();
    expect(falso.llamadas.create).toBe(2); // solo m3 y m4
    expect((await fila(t, "m1")).status).toBe("detached");
  });

  it("D12: las correcciones van antes que las altas dentro del presupuesto", async () => {
    await seguir("u1");
    await insertarSync(t, { id: "s4", match: "m4" });
    await setMatch(t, "m4", { dateTime: T0 + 60 });
    await reconciliar({ matchesPerUser: 2 });
    expect(falso.llamadas.update).toBe(1); // m4 se corrigió aunque sea el último por fecha
    expect(falso.llamadas.create).toBe(1);
    expect((await fila(t, "m4")).status).toBe("synced");
  });

  it("G8: con más usuarios que el límite se atiende primero al de más pendientes", async () => {
    await insertarSync(t, { id: "a", match: "m1", user: "u1" });
    await insertarSync(t, { id: "b1", match: "m1", user: "u2" });
    await insertarSync(t, { id: "b2", match: "m2", user: "u2" });
    for (const m of ["m1", "m2"]) await setMatch(t, m, { dateTime: T0 + 60 });
    await reconciliar({ maxUsers: 1 });
    expect((await fila(t, "m1", "u2")).status).toBe("synced");
    expect((await fila(t, "m2", "u2")).status).toBe("synced");
    expect((await fila(t, "m1", "u1")).status).toBe("needs_update");
  });

  it("un error de autenticación de un usuario no frena a los demás", async () => {
    await insertarSync(t, { id: "a", match: "m1", user: "u1" });
    await insertarSync(t, { id: "b", match: "m1", user: "u2" });
    await setMatch(t, "m1", { dateTime: T0 + 60 });
    let primera = true;
    falso.fallos.update = () => {
      if (!primera) return null;
      primera = false;
      return new CalendarApiError("unauthorized", 401);
    };
    await reconciliar();
    const estados = [(await fila(t, "m1", "u1")).status, (await fila(t, "m1", "u2")).status].sort();
    expect(estados).toEqual(["needs_update", "synced"]);
  });

  it("reintenta los failed", async () => {
    await insertarSync(t, { id: "s1", match: "m1", status: "failed" });
    await reconciliar();
    expect(falso.llamadas.update).toBe(1);
    expect((await fila(t, "m1")).status).toBe("synced");
  });
});
