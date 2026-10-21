import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/d1";
import { seedApp } from "../helpers/fixtures";
import { calendarHttp } from "../helpers/calendar-http";
import { createDb, type Database } from "../../src/lib/db";
import { calendarSyncs, matches, userTeams } from "../../drizzle/schema";
import { markOutdatedEvents, removeMatchFromCalendar, reconcileCalendars, syncMatches } from "../../src/lib/calendar/sync-service";

describe("servicio → cliente HTTP → D1", () => {
  let t: TestDb;
  let db: Database;
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  let http: ReturnType<typeof calendarHttp>;
  beforeEach(async () => {
    t = await createTestDb(); db = createDb(t.DB); fixtures = await seedApp(db);
    http = calendarHttp(); vi.stubGlobal("fetch", http.fetch);
  });
  afterEach(async () => { await t?.dispose(); });

  it.each(["google", "microsoft"])("%s: alta idempotente, reprogramación y borrado conservan los datos del usuario", async (provider) => {
    const user = provider === "google" ? fixtures.user : fixtures.other;
    expect(await syncMatches(db, {} as Env, user, ["superclasico"])).toEqual([{ matchId: "superclasico", success: true }]);
    const [stored] = await db.select().from(calendarSyncs);
    const eventId = stored.externalEventId!;
    expect(http.events.size).toBe(1);
    const created = http.events.get(eventId)!;
    Object.assign(created, provider === "google"
      ? { description: "Mis notas", reminders: { useDefault: true }, colorId: "3" }
      : { body: { contentType: "text", content: "Mis notas" }, reminderMinutesBeforeStart: 5 });
    const before = http.requests.length;
    await syncMatches(db, {} as Env, user, ["superclasico"]);
    expect(http.requests).toHaveLength(before); // al día: ni siquiera consulta el proveedor
    await db.update(matches).set({ dateTime: new Date(Date.now() + 172_800_000), venue: "Nueva sede" }).where(eq(matches.id, "superclasico"));
    expect(await markOutdatedEvents(db, user.id)).toBe(1);
    await syncMatches(db, {} as Env, user, ["superclasico"]);
    expect(http.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(http.requests.filter((r) => r.method === "PATCH")).toHaveLength(1);
    const updated = http.events.get(eventId)!;
    expect(updated).toMatchObject(provider === "google"
      ? { description: "Mis notas", reminders: { useDefault: true }, colorId: "3", location: "Nueva sede" }
      : { body: { content: "Mis notas" }, reminderMinutesBeforeStart: 5, location: { displayName: "Nueva sede" } });
    expect(await db.select().from(calendarSyncs)).toEqual([expect.objectContaining({ externalEventId: eventId, status: "synced", syncedVenue: "Nueva sede", syncedState: "scheduled" })]);
    expect(await markOutdatedEvents(db, user.id)).toBe(0);
    await removeMatchFromCalendar(db, {} as Env, user, "superclasico");
    expect(http.events.size).toBe(0);
    expect(await db.select().from(calendarSyncs)).toHaveLength(0);
  });

  it.each(["google", "microsoft"])("%s: dos requests concurrentes dejan un evento y una fila", async (provider) => {
    const user = provider === "google" ? fixtures.user : fixtures.other;
    const results = await Promise.all([syncMatches(db, {} as Env, user, ["superclasico"]), syncMatches(db, {} as Env, user, ["superclasico"])]);
    expect(results.flat().every((r) => r.success)).toBe(true);
    expect(http.events.size).toBe(1);
    expect(await db.select().from(calendarSyncs)).toHaveLength(1);
  });

  it.each([503, 429, 401])("HTTP %i al actualizar no crea otro evento ni pierde su referencia", async (status) => {
    await syncMatches(db, {} as Env, fixtures.user, ["superclasico"]);
    await db.update(matches).set({ venue: "Otra sede" });
    http.failures.push({ method: "PATCH", status, message: "Calendar unavailable" });
    const results = await syncMatches(db, {} as Env, fixtures.user, ["superclasico"]);
    expect(results[0]).toMatchObject({ success: false, code: status === 503 ? "transient" : status === 429 ? "rate_limit" : "auth" });
    expect(http.events.size).toBe(1);
    expect(http.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect((await db.select().from(calendarSyncs))[0]).toMatchObject({ status: status === 503 ? "failed" : "synced", externalEventId: expect.any(String) });
    await syncMatches(db, {} as Env, fixtures.user, ["superclasico"]);
    expect(await db.select().from(calendarSyncs)).toEqual([expect.objectContaining({ status: "synced", syncedVenue: "Otra sede", errorMessage: null })]);
  });

  it("reconcilia eventos manuales sin auto-sync y no resucita borrados por el usuario", async () => {
    await syncMatches(db, {} as Env, fixtures.user, ["superclasico"]);
    await db.update(matches).set({ venue: "Otra sede" });
    await reconcileCalendars({} as Env, db);
    expect((await db.select().from(calendarSyncs))[0]).toMatchObject({ status: "synced", syncedVenue: "Otra sede" });
    http.events.clear();
    await db.update(matches).set({ venue: "Tercera sede" });
    await reconcileCalendars({} as Env, db);
    expect((await db.select().from(calendarSyncs))[0]).toMatchObject({ status: "detached", externalEventId: null });
    await db.insert(userTeams).values({ userId: fixtures.user.id, teamId: "river", autoSync: true });
    await reconcileCalendars({} as Env, db);
    expect(http.events.size).toBe(0);
    await syncMatches(db, {} as Env, fixtures.user, ["superclasico"]);
    expect(http.events.size).toBe(1); // pedido manual explícito
  });

  it("los calendarios de distintos usuarios quedan aislados", async () => {
    await syncMatches(db, {} as Env, fixtures.user, ["superclasico"]);
    await syncMatches(db, {} as Env, fixtures.other, ["superclasico"]);
    await removeMatchFromCalendar(db, {} as Env, fixtures.other, "superclasico");
    expect(http.events.size).toBe(1);
    expect(await db.select().from(calendarSyncs)).toEqual([expect.objectContaining({ userId: fixtures.user.id })]);
  });
});
