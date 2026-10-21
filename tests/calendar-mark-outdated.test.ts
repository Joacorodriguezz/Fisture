import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "./helpers/d1";
import { createDb, type Database } from "../src/lib/db";
import { markOutdatedEvents } from "../src/lib/calendar/sync-service";

const T0 = 1_800_000_000; // epoch en segundos

describe("markOutdatedEvents", () => {
  let t: TestDb;
  let db: Database;

  const sync = (id: string, matchId: string, o: { synced?: number | null; status?: string; user?: string } = {}) =>
    t.DB.prepare(
      "INSERT INTO calendar_syncs (id, user_id, match_id, provider, status, synced_date_time) VALUES (?, ?, ?, 'google', ?, ?)"
    )
      .bind(id, o.user ?? "u1", matchId, o.status ?? "synced", o.synced === undefined ? T0 : o.synced)
      .run();
  const fila = (id: string) =>
    t.DB.prepare("SELECT status, synced_date_time AS s FROM calendar_syncs WHERE id = ?").bind(id).first<{ status: string; s: number | null }>();

  beforeAll(async () => {
    t = await createTestDb();
    db = createDb(t.DB);
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    for (const tabla of ["calendar_syncs", "matches", "teams", "leagues", "users"]) {
      await t.DB.prepare(`DELETE FROM ${tabla}`).run();
    }
    await t.DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES ('u1','a@a','A','google','g1')").run();
    await t.DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES ('u2','b@b','B','google','g2')").run();
    await t.DB.prepare("INSERT INTO leagues (id, name, country, external_id, season, is_active) VALUES ('l1','L','AR','e',2026,1)").run();
    for (const id of ["t1", "t2"]) {
      await t.DB.prepare("INSERT INTO teams (id, external_id, name, league_id) VALUES (?, ?, ?, 'l1')").bind(id, `e-${id}`, id).run();
    }
    for (const id of ["m1", "m2", "m3"]) {
      await t.DB.prepare("INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status) VALUES (?, ?, 't1','t2','l1', ?, 'scheduled')")
        .bind(id, `e-${id}`, T0)
        .run();
    }
  });

  it("marca needs_update solo si el horario del partido cambió", async () => {
    await sync("s1", "m1"); // al día
    await sync("s2", "m2", { synced: T0 - 3600 }); // el partido se movió
    expect(await markOutdatedEvents(db, "u1")).toBe(1);
    expect((await fila("s1"))?.status).toBe("synced");
    expect((await fila("s2"))?.status).toBe("needs_update");
  });

  it("completa syncedDateTime en eventos viejos sin marcarlos", async () => {
    await sync("s1", "m1", { synced: null });
    expect(await markOutdatedEvents(db, "u1")).toBe(0);
    expect(await fila("s1")).toEqual({ status: "synced", s: T0 });
  });

  it("no toca eventos de otros usuarios ni los que no están synced", async () => {
    await sync("s1", "m1", { synced: T0 - 60, user: "u2" });
    await sync("s2", "m2", { synced: T0 - 60, status: "failed" });
    expect(await markOutdatedEvents(db, "u1")).toBe(0);
    expect((await fila("s1"))?.status).toBe("synced");
    expect((await fila("s2"))?.status).toBe("failed");
  });
});
