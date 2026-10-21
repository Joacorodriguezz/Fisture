import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { fila, insertarSync, sembrar, setMatch, T0 } from "./helpers/calendar";
import { createDb, type Database } from "../src/lib/db";
import { markOutdatedEvents } from "../src/lib/calendar/sync-service";

// "Ahora" fijo, un día antes de los partidos del test
const AHORA = new Date((T0 - 86_400) * 1000);

describe("markOutdatedEvents", () => {
  let t: TestDb;
  let db: Database;

  const marcar = (userId?: string, now = AHORA) => markOutdatedEvents(db, userId, now);
  const estado = async (matchId: string, userId = "u1") => (await fila(t, matchId, userId))?.status;

  beforeAll(async () => {
    t = await createTestDb();
    db = createDb(t.DB);
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    await sembrar(t);
  });

  it("marca needs_update solo si el horario del partido cambió", async () => {
    await insertarSync(t, { id: "s1", match: "m1" }); // al día
    await insertarSync(t, { id: "s2", match: "m2", synced: T0 - 3600 }); // el partido se movió
    expect(await marcar("u1")).toBe(1);
    expect(await estado("m1")).toBe("synced");
    expect(await estado("m2")).toBe("needs_update");
  });

  it("completa syncedDateTime y syncedState en eventos viejos sin marcarlos", async () => {
    await insertarSync(t, { id: "s1", match: "m1", synced: null, state: null });
    expect(await marcar("u1")).toBe(0);
    expect(await fila(t, "m1")).toMatchObject({ status: "synced", synced_date_time: T0, synced_state: "scheduled" });
  });

  it("no toca eventos de otros usuarios ni los que no están synced", async () => {
    await insertarSync(t, { id: "s1", match: "m1", synced: T0 - 60, user: "u2" });
    await insertarSync(t, { id: "s2", match: "m2", synced: T0 - 60, status: "failed" });
    expect(await marcar("u1")).toBe(0);
    expect(await estado("m1", "u2")).toBe("synced");
    expect(await estado("m2")).toBe("failed");
  });

  it("B2: un cambio de sede marca needs_update", async () => {
    await insertarSync(t, { id: "s1", match: "m1" });
    await setMatch(t, "m1", { venue: "Monumental" });
    expect(await marcar("u1")).toBe(1);
    expect(await estado("m1")).toBe("needs_update");
  });

  it("una sede que pasa de vacía a un valor también cuenta", async () => {
    await insertarSync(t, { id: "s1", match: "m1", venue: null });
    expect(await marcar("u1")).toBe(1);
  });

  it("B3, B5: pasar a postponed o cancelled marca needs_update", async () => {
    await insertarSync(t, { id: "s1", match: "m1" });
    await insertarSync(t, { id: "s2", match: "m2" });
    await setMatch(t, "m1", { status: "postponed" });
    await setMatch(t, "m2", { status: "cancelled" });
    expect(await marcar("u1")).toBe(2);
  });

  it("B9: pasar a live o finished no marca nada", async () => {
    await insertarSync(t, { id: "s1", match: "m1" });
    await insertarSync(t, { id: "s2", match: "m2" });
    await setMatch(t, "m1", { status: "live" });
    await setMatch(t, "m2", { status: "finished" });
    expect(await marcar("u1")).toBe(0);
  });

  it("B6: una fila cancelled cuyo partido volvió a scheduled pasa a needs_update", async () => {
    await insertarSync(t, { id: "s1", match: "m1", status: "cancelled", event: null, state: "cancelled" });
    await insertarSync(t, { id: "s2", match: "m2", status: "cancelled", event: null, state: "cancelled" });
    await setMatch(t, "m2", { status: "cancelled" });
    expect(await marcar("u1")).toBe(1);
    expect(await estado("m1")).toBe("needs_update");
    expect(await estado("m2")).toBe("cancelled");
  });

  it("B7: un partido que ya se jugó no se marca", async () => {
    await insertarSync(t, { id: "s1", match: "m1", synced: T0 - 3600 });
    const despuesDelPartido = new Date((T0 + 4 * 3600) * 1000);
    expect(await marcar("u1", despuesDelPartido)).toBe(0);
    expect(await estado("m1")).toBe("synced");
  });

  it("detached nunca se marca", async () => {
    await insertarSync(t, { id: "s1", match: "m1", status: "detached", event: null, synced: T0 - 60 });
    expect(await marcar("u1")).toBe(0);
    expect(await estado("m1")).toBe("detached");
  });

  it("D12: sin userId procesa a todos los usuarios", async () => {
    await insertarSync(t, { id: "s1", match: "m1", synced: T0 - 60, user: "u1" });
    await insertarSync(t, { id: "s2", match: "m1", synced: T0 - 60, user: "u2" });
    expect(await marcar()).toBe(2);
    expect(await estado("m1", "u1")).toBe("needs_update");
    expect(await estado("m1", "u2")).toBe("needs_update");
  });
});
