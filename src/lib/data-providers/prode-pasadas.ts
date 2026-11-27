// Pasadas del prode tras el final (docs/40 D4): cada partido adoptado de ESPN se mira a las +2 h y +3 h del
// inicio, y se sigue hasta las +6 h mientras esté en vivo o sin un resultado confirmado. Comparte con el
// sync diario el armado de datos, la comparación de cambios y las sentencias del prode (sync.ts), pero solo
// toca los partidos pendientes: sin equipos, sin chequeos de consistencia y con un solo db.batch.
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { matches, leagues, prodeMatches } from "../../../drizzle/schema";
import { createDb, type Database } from "../db";
import { mensajeDeError, rootLogger, type Logger } from "../observability/logger";
import { computeRunStatus, registrarRunProde } from "../observability/sync-runs";
import type { SyncRunStatus, SyncTrigger } from "../observability/types";
import { createEspnClient } from "./espn";
import {
  cambioDePartido,
  cerrarEmpezadosDelProde,
  crearContextoProde,
  datosDePartido,
  datosParaGuardar,
  leerPartidos,
  sentenciasDelProde,
  type Adoptado,
  type Sentencia,
  type SyncEnv,
  type SyncResult,
} from "./sync";
import { LEAGUES_CONFIG, type LeagueConfig, type ProviderMatch } from "./types";

const HORA_MS = 3_600_000;
// Un partido que terminó en 90' (+2 h) y uno con alargue y penales (+3 h)
export const PASADAS_MS = [2 * HORA_MS, 3 * HORA_MS] as const;
// Hasta cuándo se repite una pasada por un dato sin confirmar o un partido que sigue en vivo
export const LIMITE_SEGUIMIENTO_MS = 6 * HORA_MS;
// Presupuesto de subrequests (docs/40 D4): el resto queda pendiente para la corrida siguiente
export const MAX_COMPETENCIAS_PRODE = 3;
// Una sentencia de D1 admite 100 parámetros
const MAX_PENDIENTES = 90;

/**
 * Partidos adoptados con una pasada pendiente: una sola consulta, que entra por prode_matches (decenas de
 * filas) y busca cada partido por clave primaria. `date_time` está en segundos; el resto, en ms.
 */
export function consultaPendientes(db: Database, ahora: number) {
  const inicio = sql`${matches.dateTime} * 1000`;
  const sinPasada = (despues: number) =>
    and(
      sql`${inicio} <= ${ahora - despues}`,
      or(isNull(prodeMatches.pasadaAt), sql`${prodeMatches.pasadaAt} < ${inicio} + ${despues}`)
    );
  const enSeguimiento = and(
    isNotNull(prodeMatches.pasadaAt),
    sql`${inicio} <= ${ahora - PASADAS_MS[0]}`,
    sql`${inicio} > ${ahora - LIMITE_SEGUIMIENTO_MS}`,
    // Terminado sin confirmar (le faltan goles o la segunda lectura), dato visto sin confirmar o todavía en vivo
    or(
      and(isNull(prodeMatches.autoConfirmadoAt), or(isNotNull(prodeMatches.autoVistoAt), eq(matches.status, "finished"))),
      eq(matches.status, "live")
    )
  );
  return db
    .select({
      matchId: matches.id,
      externalId: matches.externalId,
      dateTime: matches.dateTime,
      source: matches.source,
      leagueId: matches.leagueId,
      liga: leagues.externalId,
      pasadaAt: prodeMatches.pasadaAt,
    })
    .from(prodeMatches)
    .innerJoin(matches, eq(matches.id, prodeMatches.matchId))
    .innerJoin(leagues, eq(leagues.id, matches.leagueId))
    .where(and(isNull(prodeMatches.excludedAt), or(...PASADAS_MS.map(sinPasada), enSeguimiento)))
    .limit(MAX_PENDIENTES);
}

type Pendiente = Awaited<ReturnType<typeof consultaPendientes>>[number];

interface Competencia {
  config: LeagueConfig;
  leagueId: string;
  partidos: Pendiente[];
}

// Pendientes de ESPN por competencia (un cruce manual no tiene pasadas). Primero la menos atendida, para que el
// tope no deje siempre afuera a la misma; a igualdad, la del partido más reciente.
function porCompetencia(pendientes: Pendiente[]): Competencia[] {
  const grupos = new Map<string, Competencia>();
  const orden = (a: Pendiente, b: Pendiente) => (a.pasadaAt ?? 0) - (b.pasadaAt ?? 0) || b.dateTime.getTime() - a.dateTime.getTime();
  for (const p of [...pendientes].sort(orden)) {
    const config = LEAGUES_CONFIG.find((l) => l.externalId === p.liga && l.source === "espn");
    if (!config || p.source !== "espn") continue;
    const grupo = grupos.get(p.liga) ?? { config, leagueId: p.leagueId, partidos: [] };
    grupo.partidos.push(p);
    grupos.set(p.liga, grupo);
  }
  return [...grupos.values()];
}

export type PasadaProde =
  | { trabajo: false }
  | {
      trabajo: true;
      runId: string;
      status: Exclude<SyncRunStatus, "running">;
      partidos: number;
      competencias: number;
      cambios: number;
      confirmados: number;
      error?: string;
    };

export async function pasadaDelProde(env: SyncEnv, options: { trigger?: SyncTrigger; logger?: Logger } = {}): Promise<PasadaProde> {
  const db = createDb(env.DB);
  const logger = options.logger ?? rootLogger;
  const ahora = Date.now();

  const todas = porCompetencia(await consultaPendientes(db, ahora));
  if (todas.length === 0) return { trabajo: false };
  const competencias = todas.slice(0, MAX_COMPETENCIAS_PRODE);
  if (todas.length > competencias.length) logger.warn("prode_sync_competencias_pendientes", { cantidad: todas.length - competencias.length });

  const provider = createEspnClient();
  const results: SyncResult[] = [];
  const cierres: Sentencia[] = [];
  const cambios: Sentencia[] = [];
  const adoptados: Adoptado[] = [];
  const atendidos: string[] = [];

  for (const { config, leagueId, partidos } of competencias) {
    const result: SyncResult = {
      league: config.name,
      source: config.source,
      teamsCreated: 0,
      teamsUpdated: 0,
      matchesCreated: 0,
      matchesUpdated: 0,
      matchesSkipped: 0,
      errors: [],
    };
    results.push(result);
    try {
      // Solo el año de los partidos pendientes: un pedido a ESPN por competencia
      const years = [...new Set(partidos.map((p) => p.dateTime.getUTCFullYear()))];
      const { matches: publicados } = await provider.getFixture!(config.externalId, { years, idioma: config.idioma });
      // Un año entero sin partidos no es una respuesta creíble: la pasada queda pendiente
      if (publicados.length === 0) throw new Error(`ESPN ${config.externalId}: sin partidos publicados`);
      const porExterno = new Map<string, ProviderMatch>(publicados.map((m) => [m.externalId, m]));
      const guardados = await leerPartidos(db, inArray(matches.externalId, partidos.map((p) => p.externalId)));

      const deLaLiga: Sentencia[] = [];
      for (const actual of guardados) {
        const m = porExterno.get(actual.externalId);
        if (!m) {
          result.matchesSkipped++;
          logger.warn("prode_partido_no_publicado", { matchId: actual.id });
          continue;
        }
        // Los equipos y la fecha del fixture no se tocan: la numeración sale de la temporada completa
        const datos = datosParaGuardar(actual, m, { ...datosDePartido(m), homeTeamId: actual.homeTeamId, awayTeamId: actual.awayTeamId, round: actual.round });
        const cambio = cambioDePartido(db, actual, datos);
        if (cambio) deLaLiga.push(...cambio);
        adoptados.push({ config, m, datos, actual });
      }
      // Antes de pisar horario y estado: cierre definitivo de los que ya empezaron (docs/37 §5)
      if (deLaLiga.length) cierres.push(cerrarEmpezadosDelProde(db, leagueId));
      cambios.push(...deLaLiga);
      result.matchesUpdated = deLaLiga.length;
      atendidos.push(...partidos.map((p) => p.matchId));
    } catch (error) {
      result.errors.push(mensajeDeError(error, "Error desconocido"));
    }
  }

  let confirmados = 0;
  if (atendidos.length) {
    try {
      const prode = await sentenciasDelProde(db, provider, crearContextoProde(env.KV), adoptados);
      // Un solo batch: si algo falla no queda nada escrito y las pasadas siguen pendientes
      await db.batch([
        db.update(prodeMatches).set({ pasadaAt: ahora }).where(inArray(prodeMatches.matchId, atendidos)),
        ...cierres,
        ...cambios,
        ...prode.sentencias,
      ]);
      confirmados = prode.confirmados;
    } catch (error) {
      const mensaje = mensajeDeError(error, "Error desconocido");
      atendidos.length = 0;
      for (const r of results) {
        r.matchesUpdated = 0;
        if (r.errors.length === 0) r.errors.push(mensaje);
      }
    }
  }

  const status = computeRunStatus(results, []);
  const errores = results.flatMap((r) => r.errors);
  const error = errores.length ? errores.join("; ") : undefined;
  const runId = await registrarRunProde(db, { trigger: options.trigger ?? "admin", startedAt: ahora, finishedAt: Date.now(), status, results, error });
  const resumen = {
    partidos: atendidos.length,
    competencias: competencias.length,
    cambios: results.reduce((n, r) => n + r.matchesUpdated, 0),
    confirmados,
  };
  logger[status === "success" ? "info" : "error"]("prode_sync", { runId, status, ...resumen, ...(error ? { error } : {}) });
  return { trabajo: true, runId, status, ...resumen, ...(error ? { error } : {}) };
}
