import { eq } from "drizzle-orm";
import { createFootballApiClient } from "./client";
import { SUPPORTED_LEAGUES, getCurrentSeason } from "./leagues";
import { createDb } from "../db";
import { teams, matches, leagues } from "../../../drizzle/schema";

export interface SyncResult {
  league: string;
  teamsCreated: number;
  matchesCreated: number;
  matchesUpdated: number;
  errors: string[];
}

export async function syncAllLeagues(env: Env): Promise<SyncResult[]> {
  const api = createFootballApiClient({ apiKey: env.API_FOOTBALL_KEY });
  const db = createDb(env.DB);
  const season = getCurrentSeason();
  const results: SyncResult[] = [];

  for (const league of SUPPORTED_LEAGUES) {
    const result = await syncLeague(api, db, league, season);
    results.push(result);
  }

  return results;
}

async function syncLeague(
  api: ReturnType<typeof createFootballApiClient>,
  db: ReturnType<typeof createDb>,
  league: (typeof SUPPORTED_LEAGUES)[number],
  season: number
): Promise<SyncResult> {
  const result: SyncResult = {
    league: league.name,
    teamsCreated: 0,
    matchesCreated: 0,
    matchesUpdated: 0,
    errors: [],
  };

  try {
    // 1. Asegurar que la liga existe en DB
    await db
      .insert(leagues)
      .values({
        externalId: `api-football:${league.apiId}`,
        source: "api-football",
        name: league.name,
        country: league.country,
        season,
        isActive: true,
      })
      .onConflictDoUpdate({
        target: leagues.externalId,
        set: { season, isActive: true },
      });

    const dbLeague = await db.query.leagues.findFirst({
      where: eq(leagues.externalId, `api-football:${league.apiId}`),
    });

    if (!dbLeague) {
      result.errors.push("Failed to find/create league in DB");
      return result;
    }

    // 2. Sincronizar equipos (solo si no existen)
    const existingTeams = await db.query.teams.findMany({
      where: eq(teams.leagueId, dbLeague.id),
    });

    if (existingTeams.length === 0) {
      const apiTeams = await api.getTeams(league.apiId, season);

      for (const t of apiTeams) {
        await db
          .insert(teams)
          .values({
            externalId: `api-football:${t.team.id}`,
            source: "api-football",
            name: t.team.name,
            shortName: t.team.code,
            logo: t.team.logo,
            leagueId: dbLeague.id,
            country: t.team.country,
          })
          .onConflictDoNothing();

        result.teamsCreated++;
      }
    }

    // 3. Sincronizar partidos (próximos 30 días)
    const today = new Date();
    const thirtyDaysLater = new Date(today);
    thirtyDaysLater.setDate(thirtyDaysLater.getDate() + 30);

    const fixtures = await api.getFixtures(league.apiId, season, {
      from: formatDate(today),
      to: formatDate(thirtyDaysLater),
    });

    for (const fixture of fixtures) {
      const homeTeam = await db.query.teams.findFirst({
        where: eq(teams.externalId, `api-football:${fixture.teams.home.id}`),
      });
      const awayTeam = await db.query.teams.findFirst({
        where: eq(teams.externalId, `api-football:${fixture.teams.away.id}`),
      });

      if (!homeTeam || !awayTeam) {
        result.errors.push(`Teams not found for fixture ${fixture.fixture.id}`);
        continue;
      }

      const existingMatch = await db.query.matches.findFirst({
        where: eq(matches.externalId, `api-football:${fixture.fixture.id}`),
      });

      const matchData = {
        externalId: `api-football:${fixture.fixture.id}`,
        source: "api-football",
        homeTeamId: homeTeam.id,
        awayTeamId: awayTeam.id,
        leagueId: dbLeague.id,
        dateTime: new Date(fixture.fixture.date),
        venue: fixture.fixture.venue.name,
        status: mapStatus(fixture.fixture.status.short),
        homeScore: fixture.goals.home,
        awayScore: fixture.goals.away,
        round: fixture.league.round,
      };

      if (existingMatch) {
        await db
          .update(matches)
          .set({ ...matchData, updatedAt: new Date() })
          .where(eq(matches.id, existingMatch.id));
        result.matchesUpdated++;
      } else {
        await db.insert(matches).values(matchData);
        result.matchesCreated++;
      }
    }
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : "Unknown error");
  }

  return result;
}

function mapStatus(apiStatus: string): string {
  const statusMap: Record<string, string> = {
    NS: "scheduled",
    "1H": "live",
    HT: "live",
    "2H": "live",
    FT: "finished",
    AET: "finished",
    PEN: "finished",
    PST: "postponed",
    CANC: "cancelled",
    ABD: "cancelled",
    AWD: "finished",
    WO: "finished",
  };
  return statusMap[apiStatus] || "scheduled";
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}
