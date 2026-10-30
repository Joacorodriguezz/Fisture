import { eq, and, gte, lt, or, inArray, asc } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import {
  matches,
  teams,
  userTeams,
  leagues,
  calendarSyncs,
  leagueTeams,
} from "../../../drizzle/schema";
import type { Database } from "./index";
import { diaISO } from "../format";

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

// D1 admite máximo 100 parámetros por consulta. Cada equipo se usa como local y como visitante,
// así que se consultan de a 30 equipos y se combinan los resultados.
const EQUIPOS_POR_CONSULTA = 30;

export async function getMatchesForTeams(db: Database, teamIds: string[], limit: number) {
  const ahora = new Date();
  const porPartido = new Map<string, Awaited<ReturnType<typeof consultarPartidos>>[number]>();

  for (let i = 0; i < teamIds.length; i += EQUIPOS_POR_CONSULTA) {
    const lote = teamIds.slice(i, i + EQUIPOS_POR_CONSULTA);
    for (const fila of await consultarPartidos(db, lote, ahora, limit)) {
      porPartido.set(fila.match.id, fila);
    }
  }

  return [...porPartido.values()]
    .sort((a, b) => a.match.dateTime.getTime() - b.match.dateTime.getTime())
    .slice(0, limit);
}

function consultarPartidos(db: Database, teamIds: string[], desde: Date, limit: number) {
  return db
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
        gte(matches.dateTime, desde),
        or(inArray(matches.homeTeamId, teamIds), inArray(matches.awayTeamId, teamIds))
      )
    )
    .orderBy(asc(matches.dateTime))
    .limit(limit);
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
      return !state || !["synced", "detached", "cancelled"].includes(state.status);
    })
    .slice(0, limit)
    .map((r) => r.match.id);
}

// Todos los partidos de las ligas activas dentro de un rango de fechas (desde incluido, hasta excluido)
export async function getMatchesInRange(db: Database, desde: Date, hasta: Date) {
  return db
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
    .where(and(gte(matches.dateTime, desde), lt(matches.dateTime, hasta), eq(leagues.isActive, true)))
    .orderBy(asc(matches.dateTime));
}

// Cantidad de partidos por día (AAAA-MM-DD en Buenos Aires) dentro de un rango, para la tira de días de Hoy
export async function getMatchCountsByDay(db: Database, desde: Date, hasta: Date) {
  const rows = await db
    .select({ dateTime: matches.dateTime })
    .from(matches)
    .innerJoin(leagues, eq(matches.leagueId, leagues.id))
    .where(and(gte(matches.dateTime, desde), lt(matches.dateTime, hasta), eq(leagues.isActive, true)));

  const counts = new Map<string, number>();
  for (const r of rows) {
    const dia = diaISO(r.dateTime);
    counts.set(dia, (counts.get(dia) ?? 0) + 1);
  }
  return counts;
}

// Ids de los equipos que sigue el usuario
export async function getFollowedIds(db: Database, userId: string): Promise<Set<string>> {
  return new Set(await getFollowedTeamIds(db, userId));
}

// Páginas públicas dinámicas para el sitemap y llms.txt: ligas activas, sus equipos y los partidos
// de los próximos días (los pasados se dejan de listar; la página sigue existiendo)
export async function getPaginasPublicas(db: Database, ahora: Date = new Date(), dias = 60) {
  const hasta = new Date(ahora.getTime() + dias * 24 * 60 * 60 * 1000);

  const ligas = await db
    .select({ id: leagues.id, name: leagues.name, country: leagues.country })
    .from(leagues)
    .where(eq(leagues.isActive, true))
    .orderBy(asc(leagues.name));

  const equipos = await db
    .selectDistinct({ id: teams.id, updatedAt: teams.updatedAt })
    .from(leagueTeams)
    .innerJoin(teams, eq(leagueTeams.teamId, teams.id))
    .innerJoin(leagues, eq(leagueTeams.leagueId, leagues.id))
    .where(eq(leagues.isActive, true))
    .orderBy(asc(teams.id));

  const partidos = await db
    .select({ id: matches.id, updatedAt: matches.updatedAt })
    .from(matches)
    .innerJoin(leagues, eq(matches.leagueId, leagues.id))
    .where(and(gte(matches.dateTime, ahora), lt(matches.dateTime, hasta), eq(leagues.isActive, true)))
    .orderBy(asc(matches.dateTime));

  return { ligas, equipos, partidos };
}
