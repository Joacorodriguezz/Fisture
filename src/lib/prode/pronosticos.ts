// Pronósticos del prode: un marcador por usuario y partido, editable hasta el inicio.
// El cierre se decide siempre con la hora del servidor (cierraPronostico, horario.ts): el cuerpo del
// pedido nunca trae la hora, así un formulario enviado tarde se rechaza aunque se haya abierto a tiempo.
import { and, eq, sql } from "drizzle-orm";
import { matches, prodePredictions } from "../../../drizzle/schema";
import type { Database } from "../db";
import { cierraPronostico } from "./horario";
import { listarCruces, SOURCE_MANUAL, type PartidoProde } from "./partidos";

export const GOLES_MAX = 20;

export interface Marcador {
  homeGoals: number;
  awayGoals: number;
}

export type EstadoPronostico = "abierto" | "cerrado" | "jugado";

export interface PartidoConPronostico extends PartidoProde {
  cierre: string; // ISO UTC: el instante del partido, desde el que no se acepta el pronóstico
  estado: EstadoPronostico;
  pronostico: Marcador | null;
}

export type ResultadoGuardar =
  | { ok: true; pronostico: Marcador & { matchId: string } }
  | { ok: false; status: 400 | 404 | 409; error: string };

const esGol = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= GOLES_MAX;

export function validarMarcador(home: unknown, away: unknown): Marcador | null {
  return esGol(home) && esGol(away) ? { homeGoals: home, awayGoals: away } : null;
}

export function estadoDe(partido: { dateTime: Date; status: string | null }, ahora: Date): EstadoPronostico {
  if (partido.status === "finished") return "jugado";
  return cierraPronostico(partido, ahora) ? "cerrado" : "abierto";
}

const CERRADO = { ok: false, status: 409, error: "pronostico_cerrado" } as const;

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
  const [partido] = await db
    .select({ dateTime: matches.dateTime, status: matches.status })
    .from(matches)
    .where(and(eq(matches.id, matchId), eq(matches.source, SOURCE_MANUAL)))
    .limit(1);
  if (!partido) return { ok: false, status: 404, error: "partido_inexistente" };
  if (cierraPronostico(partido, ahora ?? new Date())) return CERRADO;

  // Cierre atómico: la hora y el estado se vuelven a comprobar en la misma sentencia que escribe, con la
  // hora del servidor al escribir. Un pedido demorado que llega después del inicio, o después de que el
  // admin pasó el partido a live, no afecta ninguna fila (INSERT ... SELECT ... WHERE). Mismo criterio
  // que cierraPronostico: sin empezar es status NULL, scheduled o postponed, y date_time > ahora.
  const ms = (ahora ?? new Date()).getTime();
  const escrito = await db.run(sql`
    INSERT INTO prode_predictions (user_id, match_id, home_goals, away_goals, created_at, updated_at)
    SELECT ${userId}, m.id, ${marcador.homeGoals}, ${marcador.awayGoals}, ${ms}, ${ms}
    FROM matches m
    WHERE m.id = ${matchId}
      AND m.source = ${SOURCE_MANUAL}
      AND (m.status IS NULL OR m.status IN ('scheduled', 'postponed'))
      AND m.date_time * 1000 > ${ms}
    ON CONFLICT (user_id, match_id) DO UPDATE SET
      home_goals = excluded.home_goals,
      away_goals = excluded.away_goals,
      updated_at = excluded.updated_at`);
  if (!escrito.meta.changes) return CERRADO;
  return { ok: true, pronostico: { matchId, ...marcador } };
}

// Partidos del prode con el pronóstico del usuario (o null) y su estado. Una consulta más que
// listarCruces, nunca una por partido.
export async function listarPronosticos(db: Database, userId: string, ahora: Date = new Date()): Promise<PartidoConPronostico[]> {
  const [partidos, propios] = await Promise.all([
    listarCruces(db),
    db
      .select({ matchId: prodePredictions.matchId, homeGoals: prodePredictions.homeGoals, awayGoals: prodePredictions.awayGoals })
      .from(prodePredictions)
      .where(eq(prodePredictions.userId, userId)),
  ]);
  return partidos.map((p) => {
    // horario.iso es el mismo instante de matches.date_time (los cruces se cargan al minuto)
    const dateTime = new Date(p.horario.iso);
    const mio = propios.find((x) => x.matchId === p.id);
    return {
      ...p,
      cierre: dateTime.toISOString(),
      estado: estadoDe({ dateTime, status: p.estado }, ahora),
      pronostico: mio ? { homeGoals: mio.homeGoals, awayGoals: mio.awayGoals } : null,
    };
  });
}
