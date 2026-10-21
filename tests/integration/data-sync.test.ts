import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import scoreboard from "../fixtures/espn-scoreboard.json";
import { createTestDb, type TestDb } from "../helpers/d1";
import { createDb, type Database } from "../../src/lib/db";
import { syncSingleLeague } from "../../src/lib/data-providers/sync";
import { leagues, teams, matches, leagueTeams } from "../../drizzle/schema";

describe("ingesta ESPN a D1", () => {
  let t: TestDb;
  let db: Database;
  let data: typeof scoreboard;
  beforeEach(async () => {
    t = await createTestDb(); db = createDb(t.DB);
    data = structuredClone(scoreboard);
    data.events[0].date = new Date(Date.now() + 86_400_000).toISOString();
    data.events[0].season.year = new Date().getUTCFullYear();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(data)));
  });
  afterEach(async () => { await t?.dispose(); });

  it("persiste fixture, repite sin escrituras y actualiza cambios sin duplicar", async () => {
    const first = await syncSingleLeague({ DB: t.DB }, "arg.1");
    expect(first).toMatchObject({ teamsCreated: 2, matchesCreated: 1, errors: [] });
    expect(await db.select().from(leagueTeams)).toHaveLength(2);
    const [original] = await db.select().from(matches);
    const second = await syncSingleLeague({ DB: t.DB }, "arg.1");
    expect(second).toMatchObject({ teamsCreated: 0, teamsUpdated: 0, matchesCreated: 0, matchesUpdated: 0, errors: [] });
    data.events[0].date = new Date(Date.now() + 172_800_000).toISOString();
    data.events[0].competitions[0].competitors[1].team.displayName = "River Plate actualizado";
    const third = await syncSingleLeague({ DB: t.DB }, "arg.1");
    expect(third).toMatchObject({ teamsUpdated: 1, matchesUpdated: 1, errors: [] });
    const persistedTime = new Date(Math.floor(Date.parse(data.events[0].date) / 1000) * 1000);
    expect(await db.select().from(matches)).toEqual([expect.objectContaining({ id: original.id, dateTime: persistedTime })]);
    expect(await db.select().from(teams)).toHaveLength(2);
  });
  it("comparte equipos entre liga y copa, conservando su liga de origen", async () => {
    await syncSingleLeague({ DB: t.DB }, "arg.1");
    const [liga] = await db.select().from(leagues).where(eq(leagues.externalId, "arg.1"));
    data.events[0].id = "cup-match";
    data.events[0].season.slug = "semifinals";
    expect(await syncSingleLeague({ DB: t.DB }, "conmebol.libertadores")).toMatchObject({ teamsCreated: 0, matchesCreated: 1, errors: [] });
    expect(await db.select().from(teams)).toEqual([expect.objectContaining({ leagueId: liga.id }), expect.objectContaining({ leagueId: liga.id })]);
    expect(await db.select().from(leagueTeams)).toHaveLength(4);
  });
  it("una liga desconocida y un proveedor fallido no borran datos existentes", async () => {
    await syncSingleLeague({ DB: t.DB }, "arg.1");
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 400 })));
    expect(await syncSingleLeague({ DB: t.DB }, "arg.1")).toMatchObject({ matchesCreated: 0, matchesUpdated: 0 });
    expect(await db.select().from(matches)).toHaveLength(1);
    expect((await syncSingleLeague({ DB: t.DB }, "unknown")).errors).not.toHaveLength(0);
  });
});
