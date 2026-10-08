// Tipos comunes para todos los providers de datos

export interface ProviderTeam {
  externalId: string;
  name: string;
  shortName?: string;
  logo?: string;
  country?: string;
}

export interface ProviderMatch {
  externalId: string;
  homeTeamExternalId: string;
  awayTeamExternalId: string;
  dateTime: Date;
  venue?: string;
  status: "scheduled" | "live" | "finished" | "postponed" | "cancelled";
  homeScore?: number | null;
  awayScore?: number | null;
  round?: string;
}

export interface ProviderLeague {
  externalId: string;
  name: string;
  country: string;
  logo?: string;
  season: number;
}

export interface DataProvider {
  name: string;
  getLeagues(): Promise<ProviderLeague[]>;
  getTeams(leagueExternalId: string): Promise<ProviderTeam[]>;
  getMatches(leagueExternalId: string, options?: { from?: Date; to?: Date }): Promise<ProviderMatch[]>;
}

// Configuración de ligas por provider
export type DataSource = "football-data" | "promiedos";

export interface LeagueConfig {
  externalId: string;
  name: string;
  country: string;
  source: DataSource;
}

export const LEAGUES_CONFIG: LeagueConfig[] = [
  // football-data.org (gratis para siempre)
  { externalId: "PL", name: "Premier League", country: "England", source: "football-data" },
  { externalId: "PD", name: "La Liga", country: "Spain", source: "football-data" },
  { externalId: "SA", name: "Serie A", country: "Italy", source: "football-data" },
  { externalId: "BL1", name: "Bundesliga", country: "Germany", source: "football-data" },
  { externalId: "FL1", name: "Ligue 1", country: "France", source: "football-data" },
  { externalId: "CL", name: "Champions League", country: "Europe", source: "football-data" },
  { externalId: "ELC", name: "Championship", country: "England", source: "football-data" },
  { externalId: "DED", name: "Eredivisie", country: "Netherlands", source: "football-data" },
  { externalId: "PPL", name: "Primeira Liga", country: "Portugal", source: "football-data" },
  { externalId: "BSA", name: "Serie A", country: "Brazil", source: "football-data" },

  // Promiedos (scraping)
  { externalId: "hc", name: "Liga Profesional Argentina", country: "Argentina", source: "promiedos" },
];

export function getLeaguesBySource(source: DataSource): LeagueConfig[] {
  return LEAGUES_CONFIG.filter((l) => l.source === source);
}
