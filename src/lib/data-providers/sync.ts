// Servicio de sincronización unificado para múltiples providers
//
// Pensado para los límites de D1/Workers:
// - cada consulta cuenta contra el tope de la invocación, así que se escribe en lotes (db.batch)
// - una sentencia admite como máximo 100 parámetros: los inserts multi-fila se parten en consecuencia
// - solo se escribe lo que cambió, para no gastar escrituras en un sync diario

import { and, eq, notInArray } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { createDb, type Database } from "../db";
import { teams, matches, leagues, leagueTeams } from "../../../drizzle/schema";
import {
  createEspnClient,
  createFootballDataClient,
  createPromiedosClient,
  LEAGUES_CONFIG,
  lotesDeSync,
  type DataProvider,
  type LeagueConfig,
  type ProviderMatch,
  type ProviderTeam,
} from "./index";

export interface SyncResult {
  league: string;
  source: string;
  teamsCreated: number;
  teamsUpdated: number;
  matchesCreated: number;
  matchesUpdated: number;
  matchesSkipped: number;
  errors: string[];
}

export interface SyncEnv {
  DB: D1Database;
  FOOTBALL_DATA_API_KEY?: string;
}

// Providers que no entregan la temporada completa: se piden los partidos desde unos días atrás
const DIAS_ATRAS = 30;

// Sentencias por db.batch
const TAMANO_LOTE = 50;
// Filas por INSERT multi-fila: 100 parámetros máx. / 12 columnas de matches
const FILAS_PARTIDOS = 7;
// 100 parámetros máx. / 8 columnas de teams
const FILAS_EQUIPOS = 12;
// 100 parámetros máx. / 2 columnas de league_teams
const FILAS_PARTICIPACION = 45;

type Sentencia = BatchItem<"sqlite">;

function resultadoVacio(config: LeagueConfig, errores: string[] = []): SyncResult {
  return {
    league: config.name,
    source: config.source,
    teamsCreated: 0,
    teamsUpdated: 0,
    matchesCreated: 0,
    matchesUpdated: 0,
    matchesSkipped: 0,
    errors: errores,
  };
}

function crearProvider(source: LeagueConfig["source"], env: SyncEnv): DataProvider | null {
  switch (source) {
    case "espn":
      return createEspnClient();
    case "football-data":
      return env.FOOTBALL_DATA_API_KEY ? createFootballDataClient({ apiKey: env.FOOTBALL_DATA_API_KEY }) : null;
    case "promiedos":
      return createPromiedosClient();
    default:
      return null;
  }
}

// Sincroniza todas las competencias configuradas, de a una (las ligas locales primero)
export async function syncAllLeagues(env: SyncEnv): Promise<SyncResult[]> {
  const results = await syncLeagues(env, LEAGUES_CONFIG);
  await desactivarLigasObsoletas(createDb(env.DB));
  return results;
}

export interface LoteResult {
  lote: number;
  totalLotes: number;
  // null en el último lote: no queda nada por sincronizar
  siguienteLote: number | null;
  results: SyncResult[];
}

// Sincroniza un lote de competencias (docs/22 D4): en Workers Free una invocación no alcanza para
// todas. Los lotes siguen el orden de LEAGUES_CONFIG, así las ligas se cargan antes que las copas.
// El último lote desactiva las competencias que ya no están en la configuración.
export async function syncLote(env: SyncEnv, lote: number): Promise<LoteResult> {
  const lotes = lotesDeSync();
  if (!Number.isInteger(lote) || lote < 0 || lote >= lotes.length) {
    throw new RangeError(`Lote inexistente: ${lote} (hay ${lotes.length})`);
  }

  const results = await syncLeagues(env, lotes[lote]);
  const esUltimo = lote === lotes.length - 1;
  if (esUltimo) await desactivarLigasObsoletas(createDb(env.DB));

  return { lote, totalLotes: lotes.length, siguienteLote: esUltimo ? null : lote + 1, results };
}

export async function syncSingleLeague(env: SyncEnv, leagueExternalId: string): Promise<SyncResult> {
  const config = LEAGUES_CONFIG.find((l) => l.externalId === leagueExternalId);

  if (!config) {
    return {
      league: leagueExternalId,
      source: "unknown",
      teamsCreated: 0,
      teamsUpdated: 0,
      matchesCreated: 0,
      matchesUpdated: 0,
      matchesSkipped: 0,
      errors: [`Liga no encontrada: ${leagueExternalId}`],
    };
  }

  const [result] = await syncLeagues(env, [config]);
  return result;
}

async function syncLeagues(env: SyncEnv, configs: LeagueConfig[]): Promise<SyncResult[]> {
  const db = createDb(env.DB);
  const providers = new Map<string, DataProvider | null>();
  const results: SyncResult[] = [];

  for (const config of configs) {
    if (!providers.has(config.source)) providers.set(config.source, crearProvider(config.source, env));
    const provider = providers.get(config.source);

    if (!provider) {
      results.push(resultadoVacio(config, [`Provider no disponible: ${config.source}`]));
      continue;
    }

    results.push(await syncLeague(db, provider, config));
  }

  return results;
}

// Las ligas que ya no están en la configuración dejan de mostrarse (no se borran datos)
async function desactivarLigasObsoletas(db: Database): Promise<void> {
  const activas = LEAGUES_CONFIG.map((l) => l.externalId);
  await db.update(leagues).set({ isActive: false }).where(notInArray(leagues.externalId, activas));
}

// Equipos (externalId) que participan de alguna competencia destacada activa de la fuente.
// Una copa no destacada solo guarda los partidos de estos equipos: así la FA Cup no carga
// cientos de partidos entre clubes amateurs que nadie puede seguir.
async function equiposConocidos(db: Database, source: string): Promise<Set<string>> {
  const filas = await db
    .selectDistinct({ externalId: teams.externalId })
    .from(leagueTeams)
    .innerJoin(leagues, eq(leagueTeams.leagueId, leagues.id))
    .innerJoin(teams, eq(leagueTeams.teamId, teams.id))
    .where(and(eq(leagues.isFeatured, true), eq(leagues.isActive, true), eq(teams.source, source)));
  return new Set(filas.map((f) => f.externalId));
}

// Temporada a la que pertenece hoy una competencia (la europea arranca en agosto)
function temporadaActual(config: LeagueConfig, ahora = new Date()): number {
  const anio = ahora.getUTCFullYear();
  if (config.region === "europa") return ahora.getUTCMonth() >= 7 ? anio : anio - 1;
  return anio;
}

async function ejecutarEnLotes(db: Database, sentencias: Sentencia[]): Promise<void> {
  for (let i = 0; i < sentencias.length; i += TAMANO_LOTE) {
    const lote = sentencias.slice(i, i + TAMANO_LOTE) as [Sentencia, ...Sentencia[]];
    await db.batch(lote);
  }
}

function partir<T>(items: T[], tamano: number): T[][] {
  const grupos: T[][] = [];
  for (let i = 0; i < items.length; i += tamano) grupos.push(items.slice(i, i + tamano));
  return grupos;
}

async function syncLeague(db: Database, provider: DataProvider, config: LeagueConfig): Promise<SyncResult> {
  const result = resultadoVacio(config);

  try {
    // 1. Competencia: crear o actualizar (y reactivar si estaba desactivada)
    const [liga] = await db
      .insert(leagues)
      .values({
        externalId: config.externalId,
        name: config.name,
        country: config.country,
        source: config.source,
        season: temporadaActual(config),
        isActive: true,
        isFeatured: config.destacada,
      })
      .onConflictDoUpdate({
        target: leagues.externalId,
        set: {
          name: config.name,
          country: config.country,
          source: config.source,
          season: temporadaActual(config),
          isActive: true,
          isFeatured: config.destacada,
        },
      })
      .returning({ id: leagues.id });
    const ligaId = liga.id;

    // 2. Fixture de la competencia (equipos + partidos)
    const completo = provider.getFixture
      ? await provider.getFixture(config.externalId)
      : {
          teams: await provider.getTeams(config.externalId),
          matches: await provider.getMatches(config.externalId, { from: desde() }),
        };
    const fixture = config.destacada ? completo : await soloEquiposConocidos(db, config, completo);

    // 3. Equipos: participantes de la temporada y los que aparecen en partidos que se guardan
    const participantesExternos = new Set(fixture.participantIds ?? fixture.teams.map((t) => t.externalId));
    const necesarios = new Set(participantesExternos);
    for (const m of fixture.matches) {
      necesarios.add(m.homeTeamExternalId);
      necesarios.add(m.awayTeamExternalId);
    }
    const equipoIds = await syncEquipos(
      db,
      config,
      ligaId,
      fixture.teams.filter((t) => necesarios.has(t.externalId)),
      result
    );

    // 4. Participación en la competencia (solo la temporada en curso)
    const participantes = [...participantesExternos]
      .map((externalId) => equipoIds.get(externalId))
      .filter((id): id is string => !!id)
      .map((teamId) => ({ leagueId: ligaId, teamId }));
    await ejecutarEnLotes(
      db,
      partir(participantes, FILAS_PARTICIPACION).map((filas) =>
        db.insert(leagueTeams).values(filas).onConflictDoNothing()
      )
    );

    // 5. Partidos
    await syncPartidos(db, config, ligaId, fixture.matches, equipoIds, result);
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : "Error desconocido");
  }

  return result;
}

// Copa no destacada: solo los partidos con al menos un equipo conocido. Participan los equipos
// de esos partidos (incluido el rival, para poder mostrar el cruce).
async function soloEquiposConocidos(
  db: Database,
  config: LeagueConfig,
  fixture: { teams: ProviderTeam[]; matches: ProviderMatch[] }
): Promise<{ teams: ProviderTeam[]; matches: ProviderMatch[]; participantIds: string[] }> {
  const conocidos = await equiposConocidos(db, config.source);
  const partidos = fixture.matches.filter(
    (m) => conocidos.has(m.homeTeamExternalId) || conocidos.has(m.awayTeamExternalId)
  );
  const participantes = new Set(partidos.flatMap((m) => [m.homeTeamExternalId, m.awayTeamExternalId]));
  return {
    teams: fixture.teams.filter((t) => participantes.has(t.externalId)),
    matches: partidos,
    participantIds: [...participantes],
  };
}

function desde(): Date {
  return new Date(Date.now() - DIAS_ATRAS * 24 * 60 * 60 * 1000);
}

async function syncEquipos(
  db: Database,
  config: LeagueConfig,
  ligaId: string,
  proveedor: ProviderTeam[],
  result: SyncResult
): Promise<Map<string, string>> {
  // Los IDs son globales por fuente: un equipo de la liga y de una copa es una sola fila
  const existentes = await db
    .select({
      id: teams.id,
      externalId: teams.externalId,
      name: teams.name,
      shortName: teams.shortName,
      logo: teams.logo,
      country: teams.country,
    })
    .from(teams)
    .where(eq(teams.source, config.source));
  const porExterno = new Map(existentes.map((t) => [t.externalId, t]));

  const ids = new Map<string, string>();
  const nuevos: (typeof teams.$inferInsert)[] = [];
  const cambios: Sentencia[] = [];

  for (const t of proveedor) {
    const actual = porExterno.get(t.externalId);

    if (!actual) {
      const id = crypto.randomUUID();
      ids.set(t.externalId, id);
      nuevos.push({
        id,
        externalId: t.externalId,
        name: t.name,
        shortName: t.shortName,
        logo: t.logo,
        // Las copas no tienen país propio; el equipo hereda el de su liga de origen cuando se conoce
        country: config.tipo === "liga" ? config.country : null,
        leagueId: ligaId,
        source: config.source,
      });
      continue;
    }

    ids.set(t.externalId, actual.id);
    // Un equipo que entró por una copa (sin país) pasa a su liga cuando esa liga se sincroniza:
    // p. ej. Flamengo, cargado por la Libertadores antes de que existiera el Brasileirão
    const adoptaLiga = config.tipo === "liga" && actual.country === null;
    const cambio =
      adoptaLiga ||
      actual.name !== t.name ||
      (t.shortName ?? null) !== actual.shortName ||
      (t.logo ?? null) !== actual.logo;

    if (cambio) {
      cambios.push(
        db
          .update(teams)
          .set({
            name: t.name,
            shortName: t.shortName,
            logo: t.logo,
            ...(adoptaLiga ? { leagueId: ligaId, country: config.country } : {}),
            updatedAt: new Date(),
          })
          .where(eq(teams.id, actual.id))
      );
    }
  }

  await ejecutarEnLotes(db, [
    ...partir(nuevos, FILAS_EQUIPOS).map((filas) => db.insert(teams).values(filas).onConflictDoNothing()),
    ...cambios,
  ]);

  result.teamsCreated += nuevos.length;
  result.teamsUpdated += cambios.length;
  return ids;
}

async function syncPartidos(
  db: Database,
  config: LeagueConfig,
  ligaId: string,
  proveedor: ProviderMatch[],
  equipoIds: Map<string, string>,
  result: SyncResult
): Promise<void> {
  const existentes = await db
    .select({
      id: matches.id,
      externalId: matches.externalId,
      dateTime: matches.dateTime,
      venue: matches.venue,
      status: matches.status,
      homeScore: matches.homeScore,
      awayScore: matches.awayScore,
      round: matches.round,
    })
    .from(matches)
    .where(and(eq(matches.leagueId, ligaId), eq(matches.source, config.source)));
  const porExterno = new Map(existentes.map((m) => [m.externalId, m]));

  const nuevos: (typeof matches.$inferInsert)[] = [];
  const cambios: Sentencia[] = [];

  for (const m of proveedor) {
    const homeTeamId = equipoIds.get(m.homeTeamExternalId);
    const awayTeamId = equipoIds.get(m.awayTeamExternalId);

    if (!homeTeamId || !awayTeamId) {
      result.matchesSkipped++;
      result.errors.push(
        `Equipos no encontrados para partido ${m.externalId}: home=${m.homeTeamExternalId}, away=${m.awayTeamExternalId}`
      );
      continue;
    }

    const datos = {
      homeTeamId,
      awayTeamId,
      // D1 almacena timestamps en segundos: comparar con esa precisión evita
      // reescribir un partido sin cambios si el proveedor envía milisegundos.
      dateTime: new Date(Math.floor(m.dateTime.getTime() / 1000) * 1000),
      venue: m.venue ?? null,
      status: m.status,
      homeScore: m.homeScore ?? null,
      awayScore: m.awayScore ?? null,
      round: m.round ?? null,
    };

    const actual = porExterno.get(m.externalId);

    if (!actual) {
      nuevos.push({ ...datos, externalId: m.externalId, leagueId: ligaId, source: config.source });
      continue;
    }

    const cambio =
      actual.dateTime?.getTime() !== datos.dateTime.getTime() ||
      actual.venue !== datos.venue ||
      actual.status !== datos.status ||
      actual.homeScore !== datos.homeScore ||
      actual.awayScore !== datos.awayScore ||
      actual.round !== datos.round;

    if (cambio) {
      cambios.push(
        db
          .update(matches)
          .set({ ...datos, updatedAt: new Date() })
          .where(eq(matches.id, actual.id))
      );
    }
  }

  await ejecutarEnLotes(db, [
    ...partir(nuevos, FILAS_PARTIDOS).map((filas) => db.insert(matches).values(filas).onConflictDoNothing()),
    ...cambios,
  ]);

  result.matchesCreated += nuevos.length;
  result.matchesUpdated += cambios.length;
}
