// Servicio de sincronización unificado para múltiples providers

import { eq } from "drizzle-orm";
import { createDb } from "../db";
import { teams, matches, leagues } from "../../../drizzle/schema";
import {
  createFootballDataClient,
  createPromiedosClient,
  LEAGUES_CONFIG,
  type DataProvider,
  type LeagueConfig,
} from "./index";

export interface SyncResult {
  league: string;
  source: string;
  teamsCreated: number;
  teamsUpdated: number;
  matchesCreated: number;
  matchesUpdated: number;
  errors: string[];
}

interface SyncEnv {
  DB: D1Database;
  FOOTBALL_DATA_API_KEY?: string;
}

export async function syncAllLeagues(env: SyncEnv): Promise<SyncResult[]> {
  const results: SyncResult[] = [];

  // Crear providers
  const providers: Record<string, DataProvider> = {};

  if (env.FOOTBALL_DATA_API_KEY) {
    providers["football-data"] = createFootballDataClient({ apiKey: env.FOOTBALL_DATA_API_KEY });
  }

  providers["promiedos"] = createPromiedosClient();

  // Sincronizar cada liga según su source
  for (const leagueConfig of LEAGUES_CONFIG) {
    const provider = providers[leagueConfig.source];

    if (!provider) {
      results.push({
        league: leagueConfig.name,
        source: leagueConfig.source,
        teamsCreated: 0,
        teamsUpdated: 0,
        matchesCreated: 0,
        matchesUpdated: 0,
        errors: [`Provider no disponible: ${leagueConfig.source}`],
      });
      continue;
    }

    const result = await syncLeague(env.DB, provider, leagueConfig);
    results.push(result);
  }

  return results;
}

export async function syncSingleLeague(env: SyncEnv, leagueExternalId: string): Promise<SyncResult> {
  const leagueConfig = LEAGUES_CONFIG.find((l) => l.externalId === leagueExternalId);

  if (!leagueConfig) {
    return {
      league: leagueExternalId,
      source: "unknown",
      teamsCreated: 0,
      teamsUpdated: 0,
      matchesCreated: 0,
      matchesUpdated: 0,
      errors: [`Liga no encontrada: ${leagueExternalId}`],
    };
  }

  let provider: DataProvider;

  if (leagueConfig.source === "football-data") {
    if (!env.FOOTBALL_DATA_API_KEY) {
      return {
        league: leagueConfig.name,
        source: leagueConfig.source,
        teamsCreated: 0,
        teamsUpdated: 0,
        matchesCreated: 0,
        matchesUpdated: 0,
        errors: ["FOOTBALL_DATA_API_KEY no configurada"],
      };
    }
    provider = createFootballDataClient({ apiKey: env.FOOTBALL_DATA_API_KEY });
  } else {
    provider = createPromiedosClient();
  }

  return syncLeague(env.DB, provider, leagueConfig);
}

async function syncLeague(
  d1: D1Database,
  provider: DataProvider,
  leagueConfig: LeagueConfig
): Promise<SyncResult> {
  const db = createDb(d1);
  const result: SyncResult = {
    league: leagueConfig.name,
    source: leagueConfig.source,
    teamsCreated: 0,
    teamsUpdated: 0,
    matchesCreated: 0,
    matchesUpdated: 0,
    errors: [],
  };

  try {
    // 1. Crear/actualizar liga en DB
    const existingLeague = await db.query.leagues.findFirst({
      where: eq(leagues.externalId, leagueConfig.externalId),
    });

    let dbLeagueId: string;

    if (existingLeague) {
      dbLeagueId = existingLeague.id;
    } else {
      const insertResult = await db
        .insert(leagues)
        .values({
          externalId: leagueConfig.externalId,
          name: leagueConfig.name,
          country: leagueConfig.country,
          source: leagueConfig.source,
          season: new Date().getFullYear(),
          isActive: true,
        })
        .returning({ id: leagues.id });

      dbLeagueId = insertResult[0].id;
    }

    // 2. Sincronizar equipos
    const providerTeams = await provider.getTeams(leagueConfig.externalId);

    for (const team of providerTeams) {
      const existingTeam = await db.query.teams.findFirst({
        where: eq(teams.externalId, team.externalId),
      });

      if (existingTeam) {
        await db
          .update(teams)
          .set({
            name: team.name,
            shortName: team.shortName,
            logo: team.logo,
            updatedAt: new Date(),
          })
          .where(eq(teams.id, existingTeam.id));
        result.teamsUpdated++;
      } else {
        await db.insert(teams).values({
          externalId: team.externalId,
          name: team.name,
          shortName: team.shortName,
          logo: team.logo,
          leagueId: dbLeagueId,
          country: leagueConfig.country,
          source: leagueConfig.source,
        });
        result.teamsCreated++;
      }
    }

    // 3. Sincronizar partidos (próximos 60 días)
    const now = new Date();
    const sixtyDaysLater = new Date(now);
    sixtyDaysLater.setDate(sixtyDaysLater.getDate() + 60);

    const providerMatches = await provider.getMatches(leagueConfig.externalId, {
      from: now,
      to: sixtyDaysLater,
    });

    // Construir mapa de equipos por externalId
    const teamMap = new Map<string, string>();
    const allTeams = await db.query.teams.findMany({
      where: eq(teams.leagueId, dbLeagueId),
    });
    for (const t of allTeams) {
      if (t.externalId) {
        teamMap.set(t.externalId, t.id);
      }
    }

    for (const match of providerMatches) {
      const homeTeamId = teamMap.get(match.homeTeamExternalId);
      const awayTeamId = teamMap.get(match.awayTeamExternalId);

      if (!homeTeamId || !awayTeamId) {
        result.errors.push(
          `Equipos no encontrados para partido ${match.externalId}: home=${match.homeTeamExternalId}, away=${match.awayTeamExternalId}`
        );
        continue;
      }

      const existingMatch = await db.query.matches.findFirst({
        where: eq(matches.externalId, match.externalId),
      });

      const matchData = {
        externalId: match.externalId,
        homeTeamId,
        awayTeamId,
        leagueId: dbLeagueId,
        dateTime: match.dateTime,
        venue: match.venue,
        status: match.status,
        homeScore: match.homeScore,
        awayScore: match.awayScore,
        round: match.round,
        source: leagueConfig.source,
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
    result.errors.push(error instanceof Error ? error.message : "Error desconocido");
  }

  return result;
}
