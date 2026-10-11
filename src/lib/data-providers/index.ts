// Data Providers - Sistema unificado para múltiples fuentes de datos

export type {
  DataProvider,
  ProviderTeam,
  ProviderMatch,
  ProviderLeague,
  ProviderFixture,
  FixtureOptions,
  LeagueConfig,
  DataSource,
  TipoCompetencia,
  Region,
} from "./types";
export { LEAGUES_CONFIG, getLeaguesBySource } from "./types";
export { createEspnClient } from "./espn";
export { createFootballDataClient } from "./football-data";
export { createPromiedosClient } from "./promiedos";
