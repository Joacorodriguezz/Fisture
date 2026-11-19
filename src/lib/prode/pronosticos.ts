// Pronósticos del prode: un marcador por usuario y partido, editable hasta el inicio.
// El cierre se decide siempre con la hora del servidor (cierraPronostico, horario.ts): el cuerpo del
// pedido nunca trae la hora, así un formulario enviado tarde se rechaza aunque se haya abierto a tiempo.
import { and, eq } from "drizzle-orm";
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

export async function guardarPronostico(
  db: Database,
  userId: string,
  datos: Record<string, unknown>,
  ahora: Date = new Date()
): Promise<ResultadoGuardar> {
  const { matchId } = datos;
  if (typeof matchId !== "string" || matchId.length === 0) return { ok: false, status: 400, error: "faltan_datos" };
  const marcador = validarMarcador(datos.homeGoals, datos.awayGoals);
  if (!marcador) return { ok: false, status: 400, error: "marcador_invalido" };

  const [partido] = await db
    .select({ dateTime: matches.dateTime })
    .from(matches)
    .where(and(eq(matches.id, matchId), eq(matches.source, SOURCE_MANUAL)))
    .limit(1);
  if (!partido) return { ok: false, status: 404, error: "partido_inexistente" };
  if (cierraPronostico(partido, ahora)) return { ok: false, status: 409, error: "pronostico_cerrado" };

  await db
    .insert(prodePredictions)
    .values({ userId, matchId, ...marcador, createdAt: ahora, updatedAt: ahora })
    .onConflictDoUpdate({
      target: [prodePredictions.userId, prodePredictions.matchId],
      set: { ...marcador, updatedAt: ahora },
    });
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
