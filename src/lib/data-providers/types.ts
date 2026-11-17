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
  // Ver LeagueConfig.participantes / idioma (docs/32)
  participantes?: "temporada" | "plantel-fijo";
  idioma?: "es";
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
// Define cómo se numera la temporada: la europea arranca en agosto, el resto sigue el año calendario
export type Region = "europa" | "sudamerica" | "mundial";

export interface LeagueConfig {
  externalId: string;
  name: string;
  country: string;
  source: DataSource;
  tipo: TipoCompetencia;
  region: Region;
  // Destacada: aparece en /ligas, en los filtros y en la búsqueda, con todos sus participantes.
  // No destacada (copas nacionales, supercopas, Recopa, Mundial de Clubes...): no se lista; solo
  // se guardan los partidos en los que juega algún equipo de una competencia destacada, y
  // aparecen en el fixture de ese equipo (docs/22).
  destacada: boolean;
  // De dónde salen los participantes: "temporada" (por defecto) los deduce de los partidos de la
  // temporada en curso; "plantel-fijo" los pide a /teams, porque la competencia los define aunque
  // ESPN no tenga partidos publicados (Eliminatorias: las 10 selecciones de CONMEBOL, docs/32 D4).
  participantes?: "temporada" | "plantel-fijo";
  // Idioma en que se piden los nombres de los equipos. Solo las competencias donde aparecen
  // selecciones (docs/32 D5); las de clubes no cambian para no reescribir nombres ya guardados.
  idioma?: "es";
}

  // Orden en que se listan las competencias destacadas (menor = primero). Única entre destacadas
  // (docs/36 D1); las no destacadas llevan una prioridad alta fija.
  prioridad: number;
// Competencia cuyos equipos son su "liga de origen" (alta y adopción del país): las ligas y las
// de plantel fijo (docs/32 D6)
export function defineOrigen(config: Pick<LeagueConfig, "tipo" | "participantes">): boolean {
  return config.tipo === "liga" || config.participantes === "plantel-fijo";
}

type Datos = Pick<LeagueConfig, "externalId" | "name" | "country" | "region" | "participantes" | "idioma">;
type DatosDestacada = Datos & Pick<LeagueConfig, "prioridad">;
// Las no destacadas no se listan, así que su prioridad es fija y alta
const PRIORIDAD_NO_DESTACADA = 1000;
const liga = (c: DatosDestacada): LeagueConfig => ({ ...c, tipo: "liga", source: "espn", destacada: true });
const copaDestacada = (c: DatosDestacada): LeagueConfig => ({ ...c, tipo: "copa", source: "espn", destacada: true });
const copa = (c: Datos): LeagueConfig => ({ ...c, tipo: "copa", source: "espn", destacada: false, prioridad: PRIORIDAD_NO_DESTACADA });

// Competencias que sincroniza el backend. Fuente: ESPN (sin API key); el slug de ESPN es el externalId.
// El orden importa:
// 1. las ligas van primero, así cada equipo queda asociado a su liga de origen;
// 2. después las copas destacadas, que suman sus participantes (Benfica, Celtic, Peñarol...);
// 3. al final las copas no destacadas, que solo guardan partidos de equipos ya conocidos.
export const LEAGUES_CONFIG: LeagueConfig[] = [
  // Ligas
  liga({ externalId: "eng.1", prioridad: 4, name: "Premier League", country: "Inglaterra", region: "europa" }),
  liga({ externalId: "esp.1", prioridad: 6, name: "La Liga", country: "España", region: "europa" }),
  liga({ externalId: "ita.1", prioridad: 7, name: "Serie A", country: "Italia", region: "europa" }),
  liga({ externalId: "ger.1", prioridad: 8, name: "Bundesliga", country: "Alemania", region: "europa" }),
  liga({ externalId: "fra.1", prioridad: 9, name: "Ligue 1", country: "Francia", region: "europa" }),
  liga({ externalId: "arg.1", prioridad: 1, name: "Liga Profesional Argentina", country: "Argentina", region: "sudamerica" }),
  liga({ externalId: "bra.1", prioridad: 12, name: "Brasileirão", country: "Brasil", region: "sudamerica" }),
  liga({ externalId: "uru.1", prioridad: 13, name: "Liga AUF Uruguaya", country: "Uruguay", region: "sudamerica" }),
  liga({ externalId: "col.1", prioridad: 14, name: "Liga BetPlay", country: "Colombia", region: "sudamerica" }),
  liga({ externalId: "chi.1", prioridad: 15, name: "Primera División de Chile", country: "Chile", region: "sudamerica" }),
  liga({ externalId: "ecu.1", prioridad: 16, name: "LigaPro Ecuador", country: "Ecuador", region: "sudamerica" }),
  liga({ externalId: "par.1", prioridad: 17, name: "Primera División de Paraguay", country: "Paraguay", region: "sudamerica" }),
  liga({ externalId: "per.1", prioridad: 18, name: "Liga 1 de Perú", country: "Perú", region: "sudamerica" }),
  liga({ externalId: "bol.1", prioridad: 19, name: "División Profesional de Bolivia", country: "Bolivia", region: "sudamerica" }),
  liga({ externalId: "ven.1", prioridad: 20, name: "Liga FUTVE", country: "Venezuela", region: "sudamerica" }),

  // Copas internacionales destacadas
  copaDestacada({ externalId: "uefa.champions", prioridad: 5, name: "UEFA Champions League", country: "Europa", region: "europa" }),
  copaDestacada({ externalId: "uefa.europa", prioridad: 10, name: "UEFA Europa League", country: "Europa", region: "europa" }),
  copaDestacada({ externalId: "uefa.europa.conf", prioridad: 11, name: "UEFA Conference League", country: "Europa", region: "europa" }),
  copaDestacada({ externalId: "conmebol.libertadores", prioridad: 2, name: "Copa Libertadores", country: "Sudamérica", region: "sudamerica" }),
  copaDestacada({ externalId: "conmebol.sudamericana", prioridad: 3, name: "Copa Sudamericana", country: "Sudamérica", region: "sudamerica" }),
  // Hace "conocidas" a las 10 selecciones de CONMEBOL: los amistosos y la Copa América guardan sus partidos
  copaDestacada({ externalId: "fifa.worldq.conmebol", prioridad: 21, name: "Eliminatorias Sudamericanas", country: "Sudamérica", region: "sudamerica", participantes: "plantel-fijo", idioma: "es" }),

  // Clasificatorias, supercopas y torneos de clubes: solo en el fixture de cada equipo
  copa({ externalId: "uefa.champions_qual", name: "Clasificación a la Champions League", country: "Europa", region: "europa" }),
  copa({ externalId: "uefa.europa_qual", name: "Clasificación a la Europa League", country: "Europa", region: "europa" }),
  copa({ externalId: "uefa.europa.conf_qual", name: "Clasificación a la Conference League", country: "Europa", region: "europa" }),
  copa({ externalId: "uefa.super_cup", name: "Supercopa de la UEFA", country: "Europa", region: "europa" }),
  copa({ externalId: "conmebol.recopa", name: "Recopa Sudamericana", country: "Sudamérica", region: "sudamerica" }),
  copa({ externalId: "fifa.cwc", name: "Mundial de Clubes", country: "Mundial", region: "mundial" }),
  copa({ externalId: "fifa.intercontinental_cup", name: "Copa Intercontinental", country: "Mundial", region: "mundial" }),

  // Copas nacionales: Inglaterra
  copa({ externalId: "eng.fa", name: "FA Cup", country: "Inglaterra", region: "europa" }),
  copa({ externalId: "eng.league_cup", name: "Carabao Cup", country: "Inglaterra", region: "europa" }),
  copa({ externalId: "eng.charity", name: "Community Shield", country: "Inglaterra", region: "europa" }),
  // España
  copa({ externalId: "esp.copa_del_rey", name: "Copa del Rey", country: "España", region: "europa" }),
  copa({ externalId: "esp.super_cup", name: "Supercopa de España", country: "España", region: "europa" }),
  // Italia
  copa({ externalId: "ita.coppa_italia", name: "Coppa Italia", country: "Italia", region: "europa" }),
  copa({ externalId: "ita.super_cup", name: "Supercopa de Italia", country: "Italia", region: "europa" }),
  // Alemania
  copa({ externalId: "ger.dfb_pokal", name: "Copa de Alemania", country: "Alemania", region: "europa" }),
  copa({ externalId: "ger.super_cup", name: "Supercopa de Alemania", country: "Alemania", region: "europa" }),
  copa({ externalId: "ger.playoff.relegation", name: "Promoción de la Bundesliga", country: "Alemania", region: "europa" }),
  // Francia
  copa({ externalId: "fra.coupe_de_france", name: "Copa de Francia", country: "Francia", region: "europa" }),
  copa({ externalId: "fra.super_cup", name: "Supercopa de Francia", country: "Francia", region: "europa" }),
  copa({ externalId: "fra.1.promotion.relegation", name: "Promoción de la Ligue 1", country: "Francia", region: "europa" }),
  // Argentina
  copa({ externalId: "arg.copa", name: "Copa Argentina", country: "Argentina", region: "sudamerica" }),
  copa({ externalId: "arg.supercopa", name: "Supercopa Argentina", country: "Argentina", region: "sudamerica" }),
  copa({ externalId: "arg.supercopa.internacional", name: "Supercopa Internacional", country: "Argentina", region: "sudamerica" }),
  copa({ externalId: "arg.trofeo_de_la_campeones", name: "Trofeo de Campeones", country: "Argentina", region: "sudamerica" }),
  // Brasil
  copa({ externalId: "bra.copa_do_brazil", name: "Copa do Brasil", country: "Brasil", region: "sudamerica" }),
  copa({ externalId: "bra.supercopa_do_brazil", name: "Supercopa do Brasil", country: "Brasil", region: "sudamerica" }),
  copa({ externalId: "bra.copa_do_nordeste", name: "Copa do Nordeste", country: "Brasil", region: "sudamerica" }),
  copa({ externalId: "bra.camp.paulista", name: "Campeonato Paulista", country: "Brasil", region: "sudamerica" }),
  copa({ externalId: "bra.camp.carioca", name: "Campeonato Carioca", country: "Brasil", region: "sudamerica" }),
  copa({ externalId: "bra.camp.mineiro", name: "Campeonato Mineiro", country: "Brasil", region: "sudamerica" }),
  copa({ externalId: "bra.camp.gaucho", name: "Campeonato Gaúcho", country: "Brasil", region: "sudamerica" }),
  // Colombia
  copa({ externalId: "col.copa", name: "Copa Colombia", country: "Colombia", region: "sudamerica" }),
  copa({ externalId: "col.superliga", name: "Superliga de Colombia", country: "Colombia", region: "sudamerica" }),
  // Chile
  copa({ externalId: "chi.copa_chi", name: "Copa Chile", country: "Chile", region: "sudamerica" }),
  copa({ externalId: "chi.super_cup", name: "Supercopa de Chile", country: "Chile", region: "sudamerica" }),
  // Ecuador
  copa({ externalId: "ecu.supercopa", name: "Supercopa de Ecuador", country: "Ecuador", region: "sudamerica" }),
  // Paraguay
  copa({ externalId: "par.1.supercopa", name: "Supercopa de Paraguay", country: "Paraguay", region: "sudamerica" }),
  // Bolivia
  copa({ externalId: "bol.copa", name: "Copa Bolivia", country: "Bolivia", region: "sudamerica" }),
  copa({ externalId: "bol.ply.rel", name: "Promoción de Bolivia", country: "Bolivia", region: "sudamerica" }),
  // Selecciones: solo los partidos de una selección de CONMEBOL (docs/32). Sin el Mundial por ahora.
  copa({ externalId: "fifa.friendly", name: "Amistosos internacionales", country: "Mundial", region: "mundial", idioma: "es" }),
  copa({ externalId: "conmebol.america", name: "Copa América", country: "Sudamérica", region: "sudamerica", idioma: "es" }),
];

export function getLeaguesBySource(source: DataSource): LeagueConfig[] {
  return LEAGUES_CONFIG.filter((l) => l.source === source);
}

// Competencias por invocación del sync. Workers Free admite 50 subrequests por invocación (pedidos
// a ESPN y consultas a D1): cada competencia hace 2 pedidos a ESPN (hasta 6 con reintentos) y unas
// 6 consultas a D1, más ~12 fijas del run (registro, chequeos, limpieza). De a 5 entra holgado (docs/22 D4).
export const COMPETENCIAS_POR_LOTE = 5;

export function lotesDeSync(configs: LeagueConfig[] = LEAGUES_CONFIG, tamano = COMPETENCIAS_POR_LOTE): LeagueConfig[][] {
  const lotes: LeagueConfig[][] = [];
  for (let i = 0; i < configs.length; i += tamano) lotes.push(configs.slice(i, i + tamano));
  return lotes;
}
