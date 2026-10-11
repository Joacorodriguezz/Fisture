import { eq, and, gte, or, inArray, asc } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  matches,
  teams,
  userTeams,
  leagues,
  calendarSyncs,
} from "../../../drizzle/schema";
import type { Database } from "./index";

const awayTeams = alias(teams, "away_team");

// Equipos que sigue el usuario
async function getFollowedTeamIds(db: Database, userId: string): Promise<string[]> {
  const rows = await db
    .select({ teamId: userTeams.teamId })
    .from(userTeams)
    .where(eq(userTeams.userId, userId));
  return rows.map((r) => r.teamId);
}

// Partidos próximos de los equipos del usuario (opcionalmente de uno solo)
export async function getUpcomingMatches(
  db: Database,
  userId: string,
  limit = 20,
  teamId?: string
) {
  const followed = await getFollowedTeamIds(db, userId);
  const teamIds = teamId ? followed.filter((id) => id === teamId) : followed;
  if (teamIds.length === 0) return [];

  return getMatchesForTeams(db, teamIds, limit);
}

// Partidos próximos de un equipo, sin importar quién lo sigue
export async function getTeamUpcomingMatches(db: Database, teamId: string, limit = 50) {
  return getMatchesForTeams(db, [teamId], limit);
}

async function getMatchesForTeams(db: Database, teamIds: string[], limit: number) {
  const rows = await db
    .select({
      match: matches,
      homeTeam: teams,
      awayTeam: awayTeams,
      league: leagues,
    })
    .from(matches)
    .innerJoin(teams, eq(matches.homeTeamId, teams.id))
    .innerJoin(awayTeams, eq(matches.awayTeamId, awayTeams.id))
    .innerJoin(leagues, eq(matches.leagueId, leagues.id))
    .where(
      and(
        gte(matches.dateTime, new Date()),
        or(
          inArray(matches.homeTeamId, teamIds),
          inArray(matches.awayTeamId, teamIds)
        )
      )
    )
    .orderBy(asc(matches.dateTime))
    .limit(limit);

  return rows;
}

// Detalle de un partido (con equipos y liga)
export async function getMatchDetail(db: Database, matchId: string) {
  const [row] = await db
    .select({
      match: matches,
      homeTeam: teams,
      awayTeam: awayTeams,
      league: leagues,
    })
    .from(matches)
    .innerJoin(teams, eq(matches.homeTeamId, teams.id))
    .innerJoin(awayTeams, eq(matches.awayTeamId, awayTeams.id))
    .innerJoin(leagues, eq(matches.leagueId, leagues.id))
    .where(eq(matches.id, matchId))
    .limit(1);

  return row ?? null;
}

// D1 admite máximo 100 parámetros por consulta: partimos los IN en lotes
const D1_CHUNK = 80;

// Estado de sincronización del usuario para un conjunto de partidos
export async function getSyncStates(db: Database, userId: string, matchIds: string[]) {
  const states = new Map<string, { status: string; errorMessage: string | null }>();

  for (let i = 0; i < matchIds.length; i += D1_CHUNK) {
    const lote = matchIds.slice(i, i + D1_CHUNK);
    const rows = await db
      .select()
      .from(calendarSyncs)
      .where(and(eq(calendarSyncs.userId, userId), inArray(calendarSyncs.matchId, lote)));

    for (const row of rows) {
      states.set(row.matchId, {
        status: row.status || "pending",
        errorMessage: row.errorMessage,
      });
    }
  }
  return states;
}

// Partidos próximos de los equipos con auto-sync activado (para el cron)
export async function getAutoSyncMatchIds(db: Database, userId: string, limit: number) {
  const autoTeams = await db
    .select({ teamId: userTeams.teamId })
    .from(userTeams)
    .where(and(eq(userTeams.userId, userId), eq(userTeams.autoSync, true)));

  const teamIds = autoTeams.map((t) => t.teamId);
  if (teamIds.length === 0) return [];

  const rows = await getMatchesForTeams(db, teamIds, 200);
  const states = await getSyncStates(
    db,
    userId,
    rows.map((r) => r.match.id)
  );

  return rows
    .filter((r) => {
      const state = states.get(r.match.id);
      return !state || state.status !== "synced";
    })
    .slice(0, limit)
    .map((r) => r.match.id);
}
