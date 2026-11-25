// Servicio de sincronización unificado para múltiples providers
//
// Pensado para los límites de D1/Workers:
// - cada consulta cuenta contra el tope de la invocación, así que se escribe en lotes (db.batch)
// - una sentencia admite como máximo 100 parámetros: los inserts multi-fila se parten en consecuencia
// - solo se escribe lo que cambió, para no gastar escrituras en un sync diario

import { and, eq, exists, inArray, isNull, lte, notExists, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { alias } from "drizzle-orm/sqlite-core";
import { createDb, type Database } from "../db";
import { mensajeDeError, rootLogger } from "../observability/logger";
import { guardarSlugs, resolverSlugsNuevos } from "../db/slugs";
import type { FilaSinSlug } from "../slug";
import { calendarSyncs, teams, matches, leagues, leagueTeams, prodeMatches, prodePredictions } from "../../../drizzle/schema";
import { esMismoCruce, SOURCE_MANUAL } from "../prode/partidos";
import { resultadoProde } from "./espn-resultado-prode";
import {
  cambioAuto,
  leerModoAuto,
  motivoEnEspera,
  permiteRegla,
  reglaDeEstado,
  resultadoAutoDe,
  type ModoAuto,
  type ResultadoAuto,
} from "./prode-resultado";
import { ESTADOS_EMPEZADO } from "../prode/horario";
import { logoDeCompetencia } from "../logos-competencias";
import {
  createEspnClient,
  createFootballDataClient,
  createPromiedosClient,
  defineOrigen,
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
  // Solo se lee el interruptor del resultado automático del prode (docs/40 D3)
  KV?: { get?(key: string): Promise<string | null> };
}

// Providers que no entregan la temporada completa: se piden los partidos desde unos días atrás
const DIAS_ATRAS = 30;

// Sentencias por db.batch
const TAMANO_LOTE = 50;

// Pedidos de summary de ESPN (parciales por período) por invocación, uno por partido del prode con alargue o
// penales. Presupuesto de subrequests de Workers Free (docs/22, docs/40 D1): el resto queda en espera.
export const MAX_RESUMENES_PRODE = 3;

// Estado del resultado automático del prode durante una invocación (sync diario o pasadas, docs/40 D4)
export interface ContextoProde {
  kv: SyncEnv["KV"];
  // Se lee una sola vez y solo si hay un partido del prode que mirar
  modo?: Promise<ModoAuto>;
  resumenesRestantes: number;
  // Un summary que falló corta los siguientes de la invocación (cada intento es una subrequest)
  resumenCaido: boolean;
}

export function crearContextoProde(kv: SyncEnv["KV"]): ContextoProde {
  return { kv, resumenesRestantes: MAX_RESUMENES_PRODE, resumenCaido: false };
}
// Filas por INSERT multi-fila: 100 parámetros máx. / 12 columnas de matches
const FILAS_PARTIDOS = 7;
// 100 parámetros máx. / 9 columnas de teams (con slug)
const FILAS_EQUIPOS = 11;
// 100 parámetros máx. / 2 columnas de league_teams
const FILAS_PARTICIPACION = 45;

export type Sentencia = BatchItem<"sqlite">;

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
  const conocidos: CacheConocidos = new Map();
  const results: SyncResult[] = [];
  const prode = crearContextoProde(env.KV);
  // Competencias sin slug (nuevas, o anteriores al backfill): se les asigna al final, todas juntas
  const ligasSinSlug: FilaSinSlug[] = [];

  for (const config of configs) {
    if (!providers.has(config.source)) providers.set(config.source, crearProvider(config.source, env));
    const provider = providers.get(config.source);

    if (!provider) {
      results.push(resultadoVacio(config, [`Provider no disponible: ${config.source}`]));
      continue;
    }

    results.push(await syncLeague(db, provider, config, conocidos, ligasSinSlug, prode));
    // Una competencia destacada puede sumar equipos conocidos: la próxima copa los recalcula
    if (config.destacada) conocidos.delete(config.source);
  }

  await asignarSlugsALigas(db, ligasSinSlug);
  return results;
}

// URL con nombre de las competencias nuevas (docs/33 D9): una lectura de ocupados y un batch por
// invocación, y solo si alguna competencia del lote no tiene slug. Un fallo no tumba el sync: la
// competencia sigue respondiendo por id y la próxima corrida (o el backfill) lo reintenta.
async function asignarSlugsALigas(db: Database, filas: FilaSinSlug[]): Promise<void> {
  if (filas.length === 0) return;
  try {
    await guardarSlugs(db, "leagues", await resolverSlugsNuevos(db, "leagues", filas));
  } catch (error) {
    rootLogger.warn("sync_slug_ligas_fallo", { ligas: filas.length, error: mensajeDeError(error, "Error desconocido") });
  }
}

// Las ligas que ya no están en la configuración dejan de mostrarse (no se borran datos)
async function desactivarLigasObsoletas(db: Database): Promise<void> {
  const activas = LEAGUES_CONFIG.map((l) => l.externalId);
  await db.update(leagues).set({ isActive: false }).where(notInArray(leagues.externalId, activas));
}

// Equipos conocidos por fuente, calculados una vez por invocación (docs/30 D3)
type CacheConocidos = Map<string, Set<string>>;

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

async function syncLeague(
  db: Database,
  provider: DataProvider,
  config: LeagueConfig,
  conocidos: CacheConocidos,
  ligasSinSlug: FilaSinSlug[],
  prode: ContextoProde
): Promise<SyncResult> {
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
      // El slug no se escribe acá: una vez asignado no cambia aunque cambie el nombre (docs/33 D9)
      .returning({ id: leagues.id, slug: leagues.slug, logo: leagues.logo });
    const ligaId = liga.id;
    if (!liga.slug) ligasSinSlug.push({ id: ligaId, name: config.name, country: config.country });

    // 2. Fixture de la competencia (equipos + partidos)
    const completo = provider.getFixture
      ? await provider.getFixture(config.externalId, { participantes: config.participantes, idioma: config.idioma })
      : {
          teams: await provider.getTeams(config.externalId),
          matches: await provider.getMatches(config.externalId, { from: desde() }),
        };
    // Logo de la competencia: el propio (public/logos/competencias) o, si no hay, el de ESPN. Un UPDATE solo
    // si cambió y nunca se pisa con null (docs/36 D2)
    const logoLiga = logoDeCompetencia(config.externalId, completo.logoLiga);
    if (logoLiga && logoLiga !== liga.logo) {
      await db.update(leagues).set({ logo: logoLiga }).where(eq(leagues.id, ligaId));
    }
    const fixture = config.destacada ? completo : await soloEquiposConocidos(db, config, completo, conocidos);

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
    await syncPartidos(db, provider, config, ligaId, fixture.matches, equipoIds, result, prode);
  } catch (error) {
    result.errors.push(mensajeDeError(error, "Error desconocido"));
  }

  return result;
}

// Copa no destacada: solo los partidos con al menos un equipo conocido. Participan los equipos
// de esos partidos (incluido el rival, para poder mostrar el cruce).
async function soloEquiposConocidos(
  db: Database,
  config: LeagueConfig,
  fixture: { teams: ProviderTeam[]; matches: ProviderMatch[] },
  cache: CacheConocidos
): Promise<{ teams: ProviderTeam[]; matches: ProviderMatch[]; participantIds: string[] }> {
  let conocidos = cache.get(config.source);
  if (!conocidos) {
    conocidos = await equiposConocidos(db, config.source);
    cache.set(config.source, conocidos);
  }
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
        country: defineOrigen(config) ? config.country : null,
        leagueId: ligaId,
        source: config.source,
      });
      continue;
    }

    ids.set(t.externalId, actual.id);
    // Un equipo que entró por una copa (sin país) pasa a su liga cuando esa liga se sincroniza:
    // p. ej. Flamengo, cargado por la Libertadores antes de que existiera el Brasileirão
    const adoptaLiga = defineOrigen(config) && actual.country === null;
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

  // URL con nombre (docs/33 D9): el slug va en el mismo INSERT. Solo lee los ocupados si hay equipos
  // nuevos (una consulta por índice cada 25 nombres). A los existentes no se les cambia ni se les asigna
  // acá: eso es del backfill, para no sumar escrituras ni subrequests al sync diario.
  const slugs = nuevos.length
    ? await resolverSlugsNuevos(
        db,
        "teams",
        nuevos.map((n) => ({ id: n.id!, name: n.name, country: n.country ?? null }))
      )
    : new Map<string, string>();
  for (const n of nuevos) n.slug = slugs.get(n.id!) ?? null;

  await ejecutarEnLotes(db, [
    // Solo se ignora el choque por external_id (otra corrida lo insertó): un choque de slug falla
    // a la vista en lugar de descartar el equipo en silencio
    ...partir(nuevos, FILAS_EQUIPOS).map((filas) => db.insert(teams).values(filas).onConflictDoNothing({ target: teams.externalId })),
    ...cambios,
  ]);

  result.teamsCreated += nuevos.length;
  result.teamsUpdated += cambios.length;
  return ids;
}

// Cada reemplazo de un cruce manual del prode por el de ESPN es un db.batch propio (una subrequest).
// Tope por competencia y por invocación para no pasarse del presupuesto de Workers Free (docs/22).
export const MAX_REEMPLAZOS_PRODE = 5;

export function cerrarEmpezadosDelProde(db: Database, ligaId: string): Sentencia {
  const ahora = new Date();
  const empezados = db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.leagueId, ligaId), or(lte(matches.dateTime, ahora), inArray(matches.status, [...ESTADOS_EMPEZADO]))));
  return db
    .update(prodeMatches)
    .set({ closedAt: ahora.getTime() })
    .where(and(isNull(prodeMatches.closedAt), inArray(prodeMatches.matchId, empezados)));
}

// Cierre del vínculo de un manual que ya empezó, decidido sobre la fila vigente (no la leída al
// principio del sync): antes de pasarlo al partido de ESPN, cuya hora puede ser futura (docs/37 §5)
function cerrarManualEmpezado(db: Database, manualId: string, ahora: Date): Sentencia {
  const empezado = db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.id, manualId), or(lte(matches.dateTime, ahora), inArray(matches.status, [...ESTADOS_EMPEZADO]))));
  return db
    .update(prodeMatches)
    .set({ closedAt: ahora.getTime() })
    .where(and(eq(prodeMatches.matchId, manualId), isNull(prodeMatches.closedAt), exists(empezado)));
}

// Resultado a 90' del manual (matches) para el vínculo, leído de la fila vigente dentro del batch: si el
// admin lo carga después de la lectura del sync, igual pasa. Sin resultado completo se conserva el que había.
function resultado90DelManual(manualId: string) {
  const gol = (columna: typeof matches.homeScore | typeof matches.awayScore) =>
    sql`(SELECT ${columna} FROM ${matches} WHERE ${matches.id} = ${manualId} AND ${matches.status} = 'finished' AND ${matches.homeScore} IS NOT NULL AND ${matches.awayScore} IS NOT NULL)`;
  return {
    homeGoals90: sql`COALESCE(${gol(matches.homeScore)}, ${prodeMatches.homeGoals90})`,
    awayGoals90: sql`COALESCE(${gol(matches.awayScore)}, ${prodeMatches.awayGoals90})`,
  };
}

// Partidos guardados con su vínculo del prode (docs/40 D4): `prodeId` no es nulo si está adoptado
export function leerPartidos(db: Database, condicion: SQL | undefined) {
  return db
    .select({
      id: matches.id,
      externalId: matches.externalId,
      homeTeamId: matches.homeTeamId,
      awayTeamId: matches.awayTeamId,
      dateTime: matches.dateTime,
      venue: matches.venue,
      status: matches.status,
      homeScore: matches.homeScore,
      awayScore: matches.awayScore,
      round: matches.round,
      source: matches.source,
      prodeId: prodeMatches.matchId,
      autoHomeGoals90: prodeMatches.autoHomeGoals90,
      autoAwayGoals90: prodeMatches.autoAwayGoals90,
      autoPasa: prodeMatches.autoPasa,
      autoRegla: prodeMatches.autoRegla,
      autoVistoAt: prodeMatches.autoVistoAt,
      autoConfirmadoAt: prodeMatches.autoConfirmadoAt,
    })
    .from(matches)
    .leftJoin(prodeMatches, eq(prodeMatches.matchId, matches.id))
    .where(condicion);
}

export type PartidoGuardado = Awaited<ReturnType<typeof leerPartidos>>[number];

// Lo que el proveedor dice de un partido, listo para guardar (los equipos los resuelve cada sync)
export function datosDePartido(m: ProviderMatch) {
  return {
    // D1 almacena timestamps en segundos: comparar con esa precisión evita
    // reescribir un partido sin cambios si el proveedor envía milisegundos.
    dateTime: new Date(Math.floor(m.dateTime.getTime() / 1000) * 1000),
    venue: m.venue ?? null,
    status: m.status,
    homeScore: m.homeScore ?? null,
    awayScore: m.awayScore ?? null,
    round: m.round ?? null,
  };
}

export type DatosPartido = ReturnType<typeof datosDePartido> & { homeTeamId: string; awayTeamId: string };

// El UPDATE del partido si cambió algo, o null: solo se escribe lo que cambió. En un arreglo porque un
// builder de drizzle es thenable.
export function cambioDePartido(db: Database, actual: PartidoGuardado, datos: DatosPartido): [Sentencia] | null {
  const cambio =
    actual.dateTime?.getTime() !== datos.dateTime.getTime() ||
    actual.venue !== datos.venue ||
    actual.status !== datos.status ||
    actual.homeScore !== datos.homeScore ||
    actual.awayScore !== datos.awayScore ||
    actual.round !== datos.round;
  return cambio ? [db.update(matches).set({ ...datos, updatedAt: new Date() }).where(eq(matches.id, actual.id))] : null;
}

// Un partido adoptado del prode que trajo el proveedor
export interface Adoptado {
  config: LeagueConfig;
  m: ProviderMatch;
  datos: DatosPartido;
  actual: PartidoGuardado;
}

// Columnas automáticas de los adoptados. El tope de summaries (MAX_RESUMENES_PRODE) se gasta primero en los
// partidos más recientes: unos pocos viejos que nunca cierran no dejan sin resultado a los recién terminados.
export async function sentenciasDelProde(db: Database, provider: DataProvider, prode: ContextoProde, adoptados: Adoptado[]) {
  const sentencias: Sentencia[] = [];
  let confirmados = 0;
  for (const adoptado of [...adoptados].sort((a, b) => b.datos.dateTime.getTime() - a.datos.dateTime.getTime())) {
    const resultado = await resultadoAutomatico(db, provider, prode, adoptado);
    if (!resultado) continue;
    sentencias.push(...resultado.sentencia);
    if (resultado.confirmado) confirmados++;
  }
  return { sentencias, confirmados };
}

// Resultado automático de un partido adoptado del prode (docs/40 D1, D2 y §4.3). Devuelve el UPDATE de las
// columnas automáticas cuando cambian el dato o la confirmación; nunca toca las manuales. Todo lo dudoso
// deja el partido en espera (sin puntos): un fallo del summary no hace fallar el sync.
async function resultadoAutomatico(
  db: Database,
  provider: DataProvider,
  prode: ContextoProde,
  { config, m, datos, actual }: Adoptado
): Promise<{ sentencia: [Sentencia]; confirmado: boolean } | null> {
  // Solo ESPN trae el estado crudo del que sale el resultado
  if (m.estadoProveedor === undefined) return null;
  prode.modo ??= leerModoAuto(prode.kv, rootLogger);
  const modo = await prode.modo;
  if (modo === "off") return null;
  // Con solo-a o solo-b, un partido de la otra regla no se toca (ni se vacía)
  const regla = reglaDeEstado(m.estadoProveedor) ?? (actual.autoRegla === "A" || actual.autoRegla === "B" ? actual.autoRegla : null);
  if (!permiteRegla(modo, regla)) return null;

  const ahora = Date.now();
  let nuevo: ResultadoAuto = resultadoAutoDe(m);
  let resumen: "no_pedido" | "ok" | "fallo" = "no_pedido";

  // Alargue o penales: el marcador a 90' sale del summary (parciales por período), una subrequest por partido
  if (m.crudoProde && provider.getResumenProde) {
    const sinCambios =
      actual.autoConfirmadoAt !== null &&
      // Un dato parcial (solo quién pasa, sin los 90') no alcanza: se vuelve a pedir
      actual.autoHomeGoals90 !== null &&
      actual.autoRegla === "B" &&
      actual.status === datos.status &&
      actual.homeScore === datos.homeScore &&
      actual.awayScore === datos.awayScore &&
      actual.autoPasa === (m.pasa ?? null);
    // Ya confirmado y sin cambios en el scoreboard: no se pide de nuevo
    if (sinCambios) return null;
    if (prode.resumenesRestantes > 0 && !prode.resumenCaido) {
      prode.resumenesRestantes--;
      try {
        const detalle = await provider.getResumenProde(config.externalId, m.externalId);
        resumen = "ok";
        nuevo = resultadoAutoDe(resultadoProde(m.crudoProde, detalle ?? undefined));
      } catch (error) {
        prode.resumenCaido = true;
        resumen = "fallo";
        rootLogger.warn("prode_resumen_fallo", { matchId: actual.id, error: mensajeDeError(error, "Error desconocido") });
      }
    } else {
      resumen = "fallo";
    }
  }

  const cambio = cambioAuto(actual, nuevo, ahora, datos.dateTime.getTime());
  const confirmado = (cambio ?? actual).autoConfirmadoAt !== null;
  if (datos.status === "finished") {
    const motivo = motivoEnEspera(m.estadoProveedor, nuevo, confirmado, resumen);
    if (motivo) rootLogger.info("prode_resultado_en_espera", { matchId: actual.id, estadoProveedor: m.estadoProveedor, motivo });
  }
  if (!cambio) return null;
  // En un arreglo: un builder de drizzle es thenable y una función async lo ejecutaría al devolverlo
  return {
    sentencia: [db.update(prodeMatches).set(cambio).where(eq(prodeMatches.matchId, actual.id))],
    confirmado: cambio.autoConfirmadoAt !== null && cambio.autoConfirmadoAt !== actual.autoConfirmadoAt,
  };
}

async function syncPartidos(
  db: Database,
  provider: DataProvider,
  config: LeagueConfig,
  ligaId: string,
  proveedor: ProviderMatch[],
  equipoIds: Map<string, string>,
  result: SyncResult,
  prode: ContextoProde
): Promise<void> {
  // La misma consulta indexada (league_id, source) trae también los cruces manuales del prode de la
  // liga: sin subrequests de más para reemplazarlos cuando ESPN publica el mismo partido.
  const filas = await leerPartidos(db, and(eq(matches.leagueId, ligaId), inArray(matches.source, [config.source, SOURCE_MANUAL])));
  const existentes = filas.filter((m) => m.source === config.source);
  const manuales = filas.filter((m) => m.source === SOURCE_MANUAL);
  const porExterno = new Map(existentes.map((m) => [m.externalId, m]));

  const nuevos: (typeof matches.$inferInsert)[] = [];
  const cambios: Sentencia[] = [];
  // Partidos adoptados del prode que trae el proveedor: su resultado automático se resuelve después del recorrido
  const adoptados: Adoptado[] = [];
  // Cada reemplazo va en su propio batch atómico. El seguimiento del calendario pasa al partido de
  // ESPN antes de que el borrado del manual se lleve sus filas por cascada.
  const reemplazos: [Sentencia, ...Sentencia[]][] = [];
  const syncDeEspn = alias(calendarSyncs, "sync_de_espn");
  let reemplazosPendientes = 0;

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

    const datos = { homeTeamId, awayTeamId, ...datosDePartido(m) };

    const actual = porExterno.get(m.externalId);

    if (!actual) {
      const fila = { ...datos, id: crypto.randomUUID(), externalId: m.externalId, leagueId: ligaId, source: config.source };
      const i = manuales.findIndex((x) => esMismoCruce(x, datos));
      if (i === -1) {
        nuevos.push(fila);
        continue;
      }
      // Tope por invocación (subrequests, docs/22): el resto queda para la próxima corrida; el manual
      // sigue visible y no se inserta el de ESPN (sería un duplicado)
      if (reemplazos.length >= MAX_REEMPLAZOS_PRODE) {
        reemplazosPendientes++;
        continue;
      }
      const [manual] = manuales.splice(i, 1);
      reemplazos.push([
        db.insert(matches).values(fila),
        cerrarManualEmpezado(db, manual.id, new Date()),
        // El resultado a 90' del manual (matches) pasa al vínculo: en el de ESPN es el que puntúa (docs/37)
        db.update(prodeMatches).set({ matchId: fila.id, ...resultado90DelManual(manual.id) }).where(eq(prodeMatches.matchId, manual.id)),
        db.update(prodePredictions).set({ matchId: fila.id }).where(eq(prodePredictions.matchId, manual.id)),
        db.update(calendarSyncs).set({ matchId: fila.id }).where(and(
          eq(calendarSyncs.matchId, manual.id),
          notExists(db.select({ id: syncDeEspn.id }).from(syncDeEspn).where(and(
            eq(syncDeEspn.matchId, fila.id),
            eq(syncDeEspn.userId, calendarSyncs.userId),
          ))),
        )),
        db.delete(matches).where(eq(matches.id, manual.id)),
      ]);
      continue;
    }

    const cambio = cambioDePartido(db, actual, datos);
    if (cambio) cambios.push(...cambio);

    if (actual.prodeId !== null) adoptados.push({ config, m, datos, actual });
  }

  // Los cambios del prode van en el mismo batch, sin subrequests de más
  const { sentencias: cambiosProde } = await sentenciasDelProde(db, provider, prode, adoptados);

  await ejecutarEnLotes(db, [
    // Antes de pisar horario y estado: cierre definitivo de los partidos del prode de la liga que ya
    // empezaron (en vivo, terminados u hora pasada), así una fecha nueva de ESPN no reabre sus
    // pronósticos (docs/37 §5). Una sola sentencia, en el mismo batch: sin subrequests de más.
    ...(cambios.length ? [cerrarEmpezadosDelProde(db, ligaId)] : []),
    ...partir(nuevos, FILAS_PARTIDOS).map((filas) => db.insert(matches).values(filas).onConflictDoNothing()),
    ...cambios,
    ...cambiosProde,
  ]);
  for (const lote of reemplazos) await db.batch(lote);
  if (reemplazos.length) rootLogger.info("prode_cruce_reemplazado_por_sync", { leagueId: ligaId, cantidad: reemplazos.length, pendientes: reemplazosPendientes });

  result.matchesCreated += nuevos.length + reemplazos.length;
  result.matchesUpdated += cambios.length;
}
