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

// Fixture completo de una competencia: equipos y partidos salen de la misma consulta
export interface ProviderFixture {
  teams: ProviderTeam[];
  matches: ProviderMatch[];
  // Equipos de la temporada en curso (externalId). Si no viene, participan todos los de teams.
  participantIds?: string[];
}

export interface FixtureOptions {
  // Años calendario a traer (por defecto el actual y el siguiente)
  years?: number[];
}

export interface DataProvider {
  name: string;
  getLeagues(): Promise<ProviderLeague[]>;
  getTeams(leagueExternalId: string): Promise<ProviderTeam[]>;
  getMatches(leagueExternalId: string, options?: { from?: Date; to?: Date }): Promise<ProviderMatch[]>;
  // Opcional: providers que entregan equipos y partidos juntos (evita pedir dos veces lo mismo)
  getFixture?(leagueExternalId: string, options?: FixtureOptions): Promise<ProviderFixture>;
}

// Configuración de competencias por provider
export type DataSource = "espn" | "football-data" | "promiedos";

export type TipoCompetencia = "liga" | "copa";
export type Region = "europa" | "sudamerica";

export interface LeagueConfig {
  externalId: string;
  name: string;
  country: string;
  source: DataSource;
  tipo: TipoCompetencia;
  region: Region;
}

// Competencias que sincroniza el backend. El orden importa: las ligas locales van primero,
// así cada equipo queda asociado a su liga de origen y las copas solo agregan los que faltan.
// Fuente: ESPN (sin API key). El slug de ESPN es el externalId.
export const LEAGUES_CONFIG: LeagueConfig[] = [
  // Cinco grandes ligas de Europa
  { externalId: "eng.1", name: "Premier League", country: "Inglaterra", source: "espn", tipo: "liga", region: "europa" },
  { externalId: "esp.1", name: "La Liga", country: "España", source: "espn", tipo: "liga", region: "europa" },
  { externalId: "ita.1", name: "Serie A", country: "Italia", source: "espn", tipo: "liga", region: "europa" },
  { externalId: "ger.1", name: "Bundesliga", country: "Alemania", source: "espn", tipo: "liga", region: "europa" },
  { externalId: "fra.1", name: "Ligue 1", country: "Francia", source: "espn", tipo: "liga", region: "europa" },

  // Argentina
  { externalId: "arg.1", name: "Liga Profesional Argentina", country: "Argentina", source: "espn", tipo: "liga", region: "sudamerica" },

  // Competencias internacionales de clubes: Europa
  { externalId: "uefa.champions", name: "UEFA Champions League", country: "Europa", source: "espn", tipo: "copa", region: "europa" },
  { externalId: "uefa.europa", name: "UEFA Europa League", country: "Europa", source: "espn", tipo: "copa", region: "europa" },
  { externalId: "uefa.europa.conf", name: "UEFA Conference League", country: "Europa", source: "espn", tipo: "copa", region: "europa" },
  { externalId: "uefa.super_cup", name: "Supercopa de la UEFA", country: "Europa", source: "espn", tipo: "copa", region: "europa" },

  // Competencias internacionales de clubes: Sudamérica
  { externalId: "conmebol.libertadores", name: "Copa Libertadores", country: "Sudamérica", source: "espn", tipo: "copa", region: "sudamerica" },
  { externalId: "conmebol.sudamericana", name: "Copa Sudamericana", country: "Sudamérica", source: "espn", tipo: "copa", region: "sudamerica" },
  { externalId: "conmebol.recopa", name: "Recopa Sudamericana", country: "Sudamérica", source: "espn", tipo: "copa", region: "sudamerica" },
];

export function getLeaguesBySource(source: DataSource): LeagueConfig[] {
  return LEAGUES_CONFIG.filter((l) => l.source === source);
}
