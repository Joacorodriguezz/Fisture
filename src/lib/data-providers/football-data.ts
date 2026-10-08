// Cliente para football-data.org API
// Documentación: https://www.football-data.org/documentation/api

import type { DataProvider, ProviderTeam, ProviderMatch, ProviderLeague } from "./types";

const BASE_URL = "https://api.football-data.org/v4";

interface FootballDataConfig {
  apiKey: string;
}

interface FDTeam {
  id: number;
  name: string;
  shortName: string;
  tla: string;
  crest: string;
}

interface FDMatch {
  id: number;
  utcDate: string;
  status: "SCHEDULED" | "TIMED" | "IN_PLAY" | "PAUSED" | "FINISHED" | "SUSPENDED" | "POSTPONED" | "CANCELLED" | "AWARDED";
  matchday: number;
  homeTeam: { id: number; name: string; shortName: string; crest: string };
  awayTeam: { id: number; name: string; shortName: string; crest: string };
  score: {
    fullTime: { home: number | null; away: number | null };
  };
  venue?: string;
}

interface FDCompetition {
  id: number;
  code: string;
  name: string;
  type: string;
  emblem: string;
  area: { name: string; code: string; flag: string };
  currentSeason: { id: number; startDate: string; endDate: string; currentMatchday: number };
}

export function createFootballDataClient(config: FootballDataConfig): DataProvider {
  const headers = {
    "X-Auth-Token": config.apiKey,
  };

  async function fetchApi<T>(endpoint: string): Promise<T> {
    const response = await fetch(`${BASE_URL}${endpoint}`, { headers });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Football-data API error: ${response.status} - ${errorText}`);
    }

    return response.json();
  }

  return {
    name: "football-data",

    async getLeagues(): Promise<ProviderLeague[]> {
      const data = await fetchApi<{ competitions: FDCompetition[] }>("/competitions");

      return data.competitions.map((comp) => ({
        externalId: comp.code,
        name: comp.name,
        country: comp.area.name,
        logo: comp.emblem,
        season: comp.currentSeason ? new Date(comp.currentSeason.startDate).getFullYear() : new Date().getFullYear(),
      }));
    },

    async getTeams(leagueCode: string): Promise<ProviderTeam[]> {
      const data = await fetchApi<{ teams: FDTeam[] }>(`/competitions/${leagueCode}/teams`);

      return data.teams.map((team) => ({
        externalId: String(team.id),
        name: team.name,
        shortName: team.tla || team.shortName,
        logo: team.crest,
      }));
    },

    async getMatches(leagueCode: string, options?: { from?: Date; to?: Date }): Promise<ProviderMatch[]> {
      let endpoint = `/competitions/${leagueCode}/matches`;
      const params = new URLSearchParams();

      if (options?.from) {
        params.set("dateFrom", formatDate(options.from));
      }
      if (options?.to) {
        params.set("dateTo", formatDate(options.to));
      }

      // Solo partidos programados y en curso
      params.set("status", "SCHEDULED,TIMED,IN_PLAY,PAUSED,FINISHED");

      if (params.toString()) {
        endpoint += `?${params.toString()}`;
      }

      const data = await fetchApi<{ matches: FDMatch[] }>(endpoint);

      return data.matches.map((match) => ({
        externalId: String(match.id),
        homeTeamExternalId: String(match.homeTeam.id),
        awayTeamExternalId: String(match.awayTeam.id),
        dateTime: new Date(match.utcDate),
        venue: match.venue,
        status: mapStatus(match.status),
        homeScore: match.score.fullTime.home,
        awayScore: match.score.fullTime.away,
        round: match.matchday ? `Matchday ${match.matchday}` : undefined,
      }));
    },
  };
}

function mapStatus(status: FDMatch["status"]): ProviderMatch["status"] {
  const map: Record<FDMatch["status"], ProviderMatch["status"]> = {
    SCHEDULED: "scheduled",
    TIMED: "scheduled",
    IN_PLAY: "live",
    PAUSED: "live",
    FINISHED: "finished",
    SUSPENDED: "postponed",
    POSTPONED: "postponed",
    CANCELLED: "cancelled",
    AWARDED: "finished",
  };
  return map[status] || "scheduled";
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0];
}
