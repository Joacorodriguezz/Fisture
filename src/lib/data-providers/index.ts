// Data Providers - Sistema unificado para múltiples fuentes de datos

export type { DataProvider, ProviderTeam, ProviderMatch, ProviderLeague, LeagueConfig, DataSource } from "./types";
export { LEAGUES_CONFIG, getLeaguesBySource } from "./types";
export { createFootballDataClient } from "./football-data";
export { createPromiedosClient } from "./promiedos";
