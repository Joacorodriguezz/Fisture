import { afterEach, beforeEach, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/d1";
import { createDb, type Database } from "../../src/lib/db";
import { seedApp } from "../helpers/fixtures";
import { matches, userTeams, calendarSyncs } from "../../drizzle/schema";
import { getUpcomingMatches, getMatchesForTeams, getMatchesInRange, getFollowedIds, getSyncStates } from "../../src/lib/db/queries";

let t: TestDb;
let db: Database;
beforeEach(async () => { t = await createTestDb(); db = createDb(t.DB); await seedApp(db); });
afterEach(async () => { await t?.dispose(); });

it("aísla partidos por usuario, excluye el pasado y elimina duplicados", async () => {
  await db.insert(userTeams).values([{ userId: "user-1", teamId: "river" }, { userId: "user-1", teamId: "boca" }]);
  await db.insert(matches).values({ id: "past", externalId: "past", leagueId: "test-league", homeTeamId: "river", awayTeamId: "boca", dateTime: new Date(Date.now() - 86_400_000) });
  expect(await getUpcomingMatches(db, "user-2")).toEqual([]);
  expect(await getUpcomingMatches(db, "user-1", 20, "unknown")).toEqual([]);
  expect(await getUpcomingMatches(db, "user-1")).toEqual([expect.objectContaining({ match: expect.objectContaining({ id: "superclasico" }) })]);
  const ids = ["river", "boca", ...Array.from({ length: 100 }, (_, i) => `missing-${i}`), "river"];
  expect(await getMatchesForTeams(db, ids, 10)).toHaveLength(1);
  expect(await getFollowedIds(db, "user-1")).toEqual(new Set(["river", "boca"]));
});

it("usa rangos semiabiertos y divide estados en lotes sin filtrar datos de otro usuario", async () => {
  const [match] = await db.select().from(matches);
  expect(await getMatchesInRange(db, new Date(match.dateTime.getTime() - 1000), match.dateTime)).toEqual([]);
  expect(await getMatchesInRange(db, match.dateTime, new Date(match.dateTime.getTime() + 1000))).toHaveLength(1);
  await db.insert(calendarSyncs).values({ userId: "user-1", matchId: match.id, provider: "google", status: "synced" });
  const ids = [match.id, ...Array.from({ length: 100 }, (_, i) => `missing-${i}`)];
  expect(await getSyncStates(db, "user-1", ids)).toEqual(new Map([[match.id, { status: "synced", errorMessage: null }]]));
  expect(await getSyncStates(db, "user-2", ids)).toEqual(new Map());
});
