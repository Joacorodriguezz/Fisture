import { eq, and, gte, or, inArray } from "drizzle-orm";
import { matches, teams, userTeams, leagues } from "../../../drizzle/schema";
import type { Database } from "./index";

// Obtener partidos próximos del usuario
export async function getUpcomingMatches(
  db: Database,
  userId: string,
  limit = 20
) {
  const now = new Date();

  // Primero obtener los equipos del usuario
  const userTeamRows = await db
    .select({ teamId: userTeams.teamId })
    .from(userTeams)
    .where(eq(userTeams.userId, userId));

  const teamIds = userTeamRows.map((ut) => ut.teamId);
  if (teamIds.length === 0) return [];

  // Obtener los partidos con info de equipos y liga
  const results = await db
    .select({
      match: matches,
      homeTeam: teams,
      league: leagues,
    })
    .from(matches)
    .innerJoin(teams, eq(matches.homeTeamId, teams.id))
    .innerJoin(leagues, eq(matches.leagueId, leagues.id))
    .where(
      and(
        gte(matches.dateTime, now),
        or(
          inArray(matches.homeTeamId, teamIds),
          inArray(matches.awayTeamId, teamIds)
        )
      )
    )
    .orderBy(matches.dateTime)
    .limit(limit);

  // Obtener away teams
  const awayTeamIds = results.map((r) => r.match.awayTeamId);
  if (awayTeamIds.length === 0) return [];

  const awayTeamsData = await db
    .select()
    .from(teams)
    .where(inArray(teams.id, awayTeamIds));

  const awayTeamsMap = new Map(awayTeamsData.map((t) => [t.id, t]));

  return results.map((r) => ({
    match: r.match,
    homeTeam: r.homeTeam,
    awayTeam: awayTeamsMap.get(r.match.awayTeamId)!,
    league: r.league,
  }));
}
