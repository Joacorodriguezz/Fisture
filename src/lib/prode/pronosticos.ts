// Pronósticos del prode: un marcador por usuario y partido, editable hasta el inicio.
// El cierre se decide siempre con la hora del servidor (cierraPronostico, horario.ts): el cuerpo del
// pedido nunca trae la hora, así un formulario enviado tarde se rechaza aunque se haya abierto a tiempo.
import { eq, inArray, sql } from "drizzle-orm";
import { matches, prodeMatches, prodePredictions } from "../../../drizzle/schema";
import type { Database } from "../db";
import { cierraPronostico, ESTADOS_SIN_EMPEZAR } from "./horario";
import { listarCruces, type PartidoProde } from "./partidos";
import type { Lado } from "./reglas";

export const GOLES_MAX = 20;

export interface Marcador {
  homeGoals: number;
  awayGoals: number;
}

/** Pronóstico guardado: `pasa` solo con empate (con ganador se deriva del marcador); null si no hay (docs/40 R2). */
export interface Pronostico extends Marcador {
  pasa: Lado | null;
}

export type EstadoPronostico = "abierto" | "cerrado" | "jugado";

export interface PartidoConPronostico extends PartidoProde {
  cierre: string; // ISO UTC: el instante del partido, desde el que no se acepta el pronóstico
  estado: EstadoPronostico;
  pronostico: Pronostico | null;
}

export type ResultadoGuardar =
  | { ok: true; pronostico: Pronostico & { matchId: string } }
  | { ok: false; status: 400 | 404 | 409; error: string };

const esLado = (v: unknown): v is Lado => v === "home" || v === "away";

const esGol = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= GOLES_MAX;

export function validarMarcador(home: unknown, away: unknown): Marcador | null {
  return esGol(home) && esGol(away) ? { homeGoals: home, awayGoals: away } : null;
}

export function estadoDe(partido: { dateTime: Date; status: string | null; closedAt?: number | null }, ahora: Date): EstadoPronostico {
  if (partido.status === "finished") return "jugado";
  return cierraPronostico(partido, ahora) ? "cerrado" : "abierto";
}

const CERRADO = { ok: false, status: 409, error: "pronostico_cerrado" } as const;

// Equivalente SQL de !cierraPronostico: el horario de matches se guarda en segundos.
export function pronosticoAbiertoSql(ahoraMs: number) {
  return sql`${prodeMatches.closedAt} IS NULL
    AND (${matches.status} IS NULL OR ${inArray(matches.status, ESTADOS_SIN_EMPEZAR)})
    AND ${matches.dateTime} * 1000 > ${ahoraMs}`;
}

export async function guardarPronostico(
  db: Database,
  userId: string,
  datos: Record<string, unknown>,
  // Solo para tests: sin él, cada comprobación usa la hora del servidor en ese momento
  ahora?: Date
): Promise<ResultadoGuardar> {
  const { matchId } = datos;
  if (typeof matchId !== "string" || matchId.length === 0) return { ok: false, status: 400, error: "faltan_datos" };
  const marcador = validarMarcador(datos.homeGoals, datos.awayGoals);
  if (!marcador) return { ok: false, status: 400, error: "marcador_invalido" };
  // Quién pasa solo se pide con empate; con ganador se deriva y se guarda null (docs/40 R2)
  const empate = marcador.homeGoals === marcador.awayGoals;
  const [partido] = await db
    .select({ dateTime: matches.dateTime, status: matches.status, closedAt: prodeMatches.closedAt })
    .from(matches)
    .innerJoin(prodeMatches, eq(prodeMatches.matchId, matches.id))
    .where(eq(matches.id, matchId))
    .limit(1);
  if (!partido) return { ok: false, status: 404, error: "partido_inexistente" };
  if (cierraPronostico(partido, ahora ?? new Date())) return CERRADO;
  // El cierre manda sobre la falta de pasa; esta validación va antes de escribir
  if (empate && !esLado(datos.pasa)) return { ok: false, status: 400, error: "falta_quien_pasa" };
  const pasa: Lado | null = empate ? (datos.pasa as Lado) : null;

  // Cierre atómico: la hora y el estado se vuelven a comprobar en la misma sentencia que escribe, con la
  // hora del servidor al escribir. Un pedido demorado que llega después del inicio, o después de que el
  // admin pasó el partido a live, no afecta ninguna fila (INSERT ... SELECT ... WHERE). Mismo criterio
  // que cierraPronostico: sin empezar es status NULL, scheduled o postponed, date_time > ahora y sin
  // cierre definitivo (closed_at).
  const ms = (ahora ?? new Date()).getTime();
  const escrito = await db.run(sql`
    INSERT INTO prode_predictions (user_id, match_id, home_goals, away_goals, pasa, created_at, updated_at)
    SELECT ${userId}, ${matches.id}, ${marcador.homeGoals}, ${marcador.awayGoals}, ${pasa}, ${ms}, ${ms}
    FROM matches
    JOIN prode_matches ON ${prodeMatches.matchId} = ${matches.id}
    WHERE ${matches.id} = ${matchId} AND ${pronosticoAbiertoSql(ms)}
    ON CONFLICT (user_id, match_id) DO UPDATE SET
      home_goals = excluded.home_goals,
      away_goals = excluded.away_goals,
      pasa = excluded.pasa,
      updated_at = excluded.updated_at`);
  if (!escrito.meta.changes) return CERRADO;
  return { ok: true, pronostico: { matchId, ...marcador, pasa } };
}

// Partidos del prode con el pronóstico del usuario (o null) y su estado. Una consulta más que
// listarCruces, nunca una por partido.
// Resultado y quién pasó se muestran solo cuando el partido puntúa (finished, marcador efectivo y equipo que
// pasó: docs/40 R4, las mismas condiciones que puntosPorUsuario). `auto` en false: PRODE_RESULTADO_AUTO=off.
export async function listarPronosticos(db: Database, userId: string, ahora: Date = new Date(), auto = true): Promise<PartidoConPronostico[]> {
  const [partidos, propios] = await Promise.all([
    listarCruces(db, auto),
    db
      .select({ matchId: prodePredictions.matchId, homeGoals: prodePredictions.homeGoals, awayGoals: prodePredictions.awayGoals, pasa: prodePredictions.pasa })
      .from(prodePredictions)
      .where(eq(prodePredictions.userId, userId)),
  ]);
  return partidos.map(({ automatico: _automatico, excluido: _excluido, enEspera: _enEspera, pasadaEn: _pasadaEn, ...p }) => {
    // El instante exacto de matches.date_time (horario.iso está truncado al minuto: un adoptado de ESPN
    // puede empezar a las 21:00:45 y cerraría 45 s antes)
    const dateTime = new Date(p.horario.cierraEn);
    const mio = propios.find((x) => x.matchId === p.id);
    const puntua = p.estado === "finished" && p.resultado !== null && p.pasa !== null;
    return {
      ...p,
      resultado: puntua ? p.resultado : null,
      pasa: puntua ? p.pasa : null,
      cierre: dateTime.toISOString(),
      estado: estadoDe({ dateTime, status: p.estado, closedAt: p.cerradoEn }, ahora),
      pronostico: mio ? { homeGoals: mio.homeGoals, awayGoals: mio.awayGoals, pasa: esLado(mio.pasa) ? mio.pasa : null } : null,
    };
  });
}
