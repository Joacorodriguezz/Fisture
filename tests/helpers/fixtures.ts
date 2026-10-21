import { leagues, teams, matches, users, leagueTeams } from "../../drizzle/schema";
import type { Database } from "../../src/lib/db";

export async function seedApp(db: Database) {
  await db.insert(leagues).values({ id: "test-league", externalId: "test:league", name: "Liga de prueba", country: "Argentina", season: 2026 });
  await db.insert(teams).values([
    { id: "river", externalId: "test:river", name: "River Plate", shortName: "RIV", leagueId: "test-league" },
    { id: "boca", externalId: "test:boca", name: "Boca Juniors", shortName: "BOC", leagueId: "test-league" },
  ]);
  await db.insert(leagueTeams).values([{ leagueId: "test-league", teamId: "river" }, { leagueId: "test-league", teamId: "boca" }]);
  await db.insert(matches).values({ id: "superclasico", externalId: "test:match", homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league", dateTime: new Date(Date.now() + 86_400_000), venue: "Monumental", status: "scheduled" });
  const [user, other] = await db.insert(users).values([
    { id: "user-1", provider: "google", providerId: "provider-1", email: "ana@example.test", name: "Ana", accessToken: "test-token", tokenExpiresAt: Date.now() + 3_600_000 },
    { id: "user-2", provider: "microsoft", providerId: "provider-2", email: "luis@example.test", name: "Luis", accessToken: "test-token", tokenExpiresAt: Date.now() + 3_600_000 },
  ]).returning();
  return { user, other };
}
