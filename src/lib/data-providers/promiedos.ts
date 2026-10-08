// Scraper para Promiedos.com.ar
// Extrae datos de partidos de fútbol argentino

import type { DataProvider, ProviderTeam, ProviderMatch, ProviderLeague } from "./types";

const BASE_URL = "https://www.promiedos.com.ar";

interface PromiedosTeam {
  id: string;
  name: string;
  short_name: string;
  logo?: string;
}

interface PromiedosMatch {
  id: string;
  teams: [PromiedosTeam, PromiedosTeam];
  scores: [number | null, number | null];
  start_time: string; // "02-10-2026 19:15"
  status: {
    enum: number; // 1=scheduled, 3=finished
    name: string; // "Prog.", "Final"
  };
  venue?: { name: string };
}

interface PromiedosRound {
  id: string;
  name: string;
  games: PromiedosMatch[];
}

interface PromiedosData {
  props: {
    pageProps: {
      data: {
        league: {
          id: string;
          name: string;
          country: string;
          logo?: string;
        };
        games: {
          // filters puede ser un array o un objeto indexado
          filters: PromiedosRound[] | Record<string, PromiedosRound>;
        };
        teams?: PromiedosTeam[];
      };
    };
  };
}

// Mapa de ligas de Promiedos
const PROMIEDOS_LEAGUES: Record<string, { slug: string; name: string; country: string }> = {
  hc: { slug: "liga-profesional", name: "Liga Profesional Argentina", country: "Argentina" },
};

export function createPromiedosClient(): DataProvider {
  async function fetchPage(url: string): Promise<PromiedosData | null> {
    try {
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "text/html,application/xhtml+xml",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const html = await response.text();

      // Extraer __NEXT_DATA__ JSON
      const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/s);
      if (!match) {
        throw new Error("No se encontró __NEXT_DATA__");
      }

      return JSON.parse(match[1]) as PromiedosData;
    } catch (error) {
      console.error("Error fetching Promiedos:", error);
      return null;
    }
  }

  function parseDateTime(dateStr: string): Date {
    // Formato: "02-10-2026 19:15"
    const [datePart, timePart] = dateStr.split(" ");
    const [day, month, year] = datePart.split("-").map(Number);
    const [hours, minutes] = (timePart || "00:00").split(":").map(Number);

    // Crear fecha en timezone Argentina (UTC-3)
    const date = new Date(Date.UTC(year, month - 1, day, hours + 3, minutes));
    return date;
  }

  function mapStatus(status: PromiedosMatch["status"]): ProviderMatch["status"] {
    switch (status.enum) {
      case 1:
        return "scheduled";
      case 2:
        return "live";
      case 3:
        return "finished";
      default:
        return "scheduled";
    }
  }

  return {
    name: "promiedos",

    async getLeagues(): Promise<ProviderLeague[]> {
      return Object.entries(PROMIEDOS_LEAGUES).map(([id, league]) => ({
        externalId: id,
        name: league.name,
        country: league.country,
        season: new Date().getFullYear(),
      }));
    },

    async getTeams(leagueId: string): Promise<ProviderTeam[]> {
      const league = PROMIEDOS_LEAGUES[leagueId];
      if (!league) {
        throw new Error(`Liga no soportada: ${leagueId}`);
      }

      const url = `${BASE_URL}/league/${league.slug}/${leagueId}`;
      const data = await fetchPage(url);

      if (!data) {
        return [];
      }

      // Extraer equipos únicos de todos los partidos
      const teamsMap = new Map<string, ProviderTeam>();
      const filters = data.props.pageProps.data.games.filters;

      // filters puede ser array o objeto
      const rounds: PromiedosRound[] = Array.isArray(filters)
        ? filters
        : Object.values(filters);

      for (const round of rounds) {
        if (!round.games || !Array.isArray(round.games)) continue;

        for (const match of round.games) {
          if (!match.teams || !Array.isArray(match.teams)) continue;

          for (const team of match.teams) {
            if (team && team.id && !teamsMap.has(team.id)) {
              teamsMap.set(team.id, {
                externalId: team.id,
                name: team.name,
                shortName: team.short_name,
                logo: team.logo,
              });
            }
          }
        }
      }

      return Array.from(teamsMap.values());
    },

    async getMatches(leagueId: string, options?: { from?: Date; to?: Date }): Promise<ProviderMatch[]> {
      const league = PROMIEDOS_LEAGUES[leagueId];
      if (!league) {
        throw new Error(`Liga no soportada: ${leagueId}`);
      }

      const url = `${BASE_URL}/league/${league.slug}/${leagueId}`;
      const data = await fetchPage(url);

      if (!data) {
        return [];
      }

      const matchList: ProviderMatch[] = [];
      const filters = data.props.pageProps.data.games.filters;
      const now = options?.from || new Date();
      const endDate = options?.to || new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000); // 60 días

      // filters puede ser array o objeto
      const rounds: PromiedosRound[] = Array.isArray(filters)
        ? filters
        : Object.values(filters);

      for (const round of rounds) {
        if (!round.games || !Array.isArray(round.games)) continue;

        for (const match of round.games) {
          if (!match.start_time || !match.teams || match.teams.length < 2) continue;

          const dateTime = parseDateTime(match.start_time);

          // Filtrar por fecha si se especifica
          if (dateTime < now || dateTime > endDate) {
            continue;
          }

          matchList.push({
            externalId: match.id,
            homeTeamExternalId: match.teams[0].id,
            awayTeamExternalId: match.teams[1].id,
            dateTime,
            venue: match.venue?.name,
            status: mapStatus(match.status),
            homeScore: match.scores?.[0] ?? null,
            awayScore: match.scores?.[1] ?? null,
            round: round.name || `Round ${round.id}`,
          });
        }
      }

      return matchList.sort((a, b) => a.dateTime.getTime() - b.dateTime.getTime());
    },
  };
}
