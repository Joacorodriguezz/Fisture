import type { ApiFixture, ApiTeam, ApiLeague, ApiResponse } from "./types";

const API_HOST = "api-football-v1.p.rapidapi.com";

export interface FootballApiConfig {
  apiKey: string;
}

export interface GetFixturesOptions {
  from?: string;
  to?: string;
  next?: number;
}

export function createFootballApiClient(config: FootballApiConfig) {
  async function request<T>(
    endpoint: string,
    params: Record<string, string | number> = {}
  ): Promise<T> {
    const url = new URL(`https://${API_HOST}/v3${endpoint}`);

    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, String(value));
    });

    const response = await fetch(url.toString(), {
      headers: {
        "X-RapidAPI-Key": config.apiKey,
        "X-RapidAPI-Host": API_HOST,
      },
    });

    if (!response.ok) {
      if (response.status === 429) {
        throw new Error("API-Football rate limit exceeded");
      }
      throw new Error(
        `API-Football error: ${response.status} ${response.statusText}`
      );
    }

    const data: ApiResponse<T> = await response.json();

    if (data.errors && Object.keys(data.errors).length > 0) {
      throw new Error(`API-Football errors: ${JSON.stringify(data.errors)}`);
    }

    return data.response;
  }

  return {
    async getFixtures(
      leagueId: number,
      season: number,
      options?: GetFixturesOptions
    ): Promise<ApiFixture[]> {
      return request<ApiFixture[]>("/fixtures", {
        league: leagueId,
        season,
        ...(options?.from && { from: options.from }),
        ...(options?.to && { to: options.to }),
        ...(options?.next && { next: options.next }),
        timezone: "America/Argentina/Buenos_Aires",
      });
    },

    async getTeams(leagueId: number, season: number): Promise<ApiTeam[]> {
      return request<ApiTeam[]>("/teams", {
        league: leagueId,
        season,
      });
    },

    async getLeagues(country?: string): Promise<ApiLeague[]> {
      return request<ApiLeague[]>("/leagues", {
        current: "true",
        ...(country && { country }),
      });
    },
  };
}

export type FootballApiClient = ReturnType<typeof createFootballApiClient>;
