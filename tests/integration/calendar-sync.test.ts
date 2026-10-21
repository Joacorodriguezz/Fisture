import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "../helpers/d1";
import { seedApp } from "../helpers/fixtures";
import { createDb, type Database } from "../../src/lib/db";
import { calendarSyncs, matches, userTeams } from "../../drizzle/schema";
import { markOutdatedEvents, removeMatchFromCalendar, runCalendarAutoSync, syncMatches } from "../../src/lib/calendar/sync-service";

describe("calendario con D1 y proveedores HTTP simulados", () => {
  let t: TestDb;
  let db: Database;
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  let fetch: ReturnType<typeof vi.fn>;
  beforeEach(async () => {
    t = await createTestDb(); db = createDb(t.DB); fixtures = await seedApp(db);
    fetch = vi.fn().mockImplementation(async () => Response.json({ id: "external-1" }));
    vi.stubGlobal("fetch", fetch);
  });
  afterEach(async () => { await t?.dispose(); });

  it.each(["google", "microsoft"])("crea una sola vez, actualiza horario y elimina el evento de %s", async (provider) => {
    const user = provider === "google" ? fixtures.user : fixtures.other;
    expect(await syncMatches(db, {} as Env, user, ["superclasico"])).toEqual([{ matchId: "superclasico", success: true }]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain(provider === "google" ? "googleapis.com" : "graph.microsoft.com");
    await syncMatches(db, {} as Env, user, ["superclasico"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await db.select().from(calendarSyncs)).toHaveLength(1);
    await db.update(matches).set({ dateTime: new Date(Date.now() + 172_800_000) }).where(eq(matches.id, "superclasico"));
    expect(await markOutdatedEvents(db, user.id)).toBe(1);
    await syncMatches(db, {} as Env, user, ["superclasico"]);
    expect(fetch.mock.calls[1][1].method).toBe(provider === "google" ? "PUT" : "PATCH");
    expect(await db.select().from(calendarSyncs)).toHaveLength(1);
    expect(await markOutdatedEvents(db, user.id)).toBe(0);
    await removeMatchFromCalendar(db, {} as Env, user, "superclasico");
    expect(fetch.mock.calls[2][1].method).toBe("DELETE");
    expect(await db.select().from(calendarSyncs)).toHaveLength(0);
    await removeMatchFromCalendar(db, {} as Env, user, "superclasico");
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("guarda fallos del proveedor y permite reintentar sin duplicar registros", async () => {
    fetch.mockImplementationOnce(async () => Response.json({ error: { message: "Calendar unavailable" } }, { status: 503 }));
    const results = await syncMatches(db, {} as Env, fixtures.user, ["superclasico", "missing"]);
    expect(results).toEqual([
      { matchId: "superclasico", success: false, error: "Calendar unavailable" },
      { matchId: "missing", success: false, error: "Partido no encontrado" },
    ]);
    expect((await db.select().from(calendarSyncs))[0]).toMatchObject({ status: "failed", errorMessage: "Calendar unavailable" });
    await syncMatches(db, {} as Env, fixtures.user, ["superclasico"]);
    expect(await db.select().from(calendarSyncs)).toEqual([expect.objectContaining({ status: "synced", errorMessage: null })]);
  });
  it("reconcilia registros antiguos y respeta usuarios con auto-sync", async () => {
    await db.insert(userTeams).values({ userId: fixtures.user.id, teamId: "river", autoSync: true });
    await runCalendarAutoSync({} as Env, db);
    expect(fetch).toHaveBeenCalledTimes(1);
    await db.update(calendarSyncs).set({ syncedDateTime: null });
    expect(await markOutdatedEvents(db, fixtures.user.id)).toBe(0);
    expect((await db.select().from(calendarSyncs))[0].syncedDateTime).toBeInstanceOf(Date);
    expect(await db.select().from(calendarSyncs)).toEqual([expect.objectContaining({ userId: fixtures.user.id })]);
  });
  it("los calendarios de distintos usuarios quedan aislados", async () => {
    await syncMatches(db, {} as Env, fixtures.user, ["superclasico"]);
    await syncMatches(db, {} as Env, fixtures.other, ["superclasico"]);
    await removeMatchFromCalendar(db, {} as Env, fixtures.other, "superclasico");
    expect(await db.select().from(calendarSyncs)).toEqual([expect.objectContaining({ userId: fixtures.user.id })]);
  });
});
