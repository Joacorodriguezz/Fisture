// Partidos del prode de playoffs: cruces cargados a mano sobre la tabla `matches` (sin migración).
// - source = 'manual' y external_id = 'prode:<uuid>': el sync de ESPN no los toca (actualiza por
//   external_id de su proveedor y nunca borra partidos).
// - round guarda la fase (octavos, cuartos, semifinal, final).
// - date_time es el único horario: el que se muestra y el que cierra el pronóstico (horario.ts).
// Corregir el horario alcanza para el calendario: la reconciliación compara date_time con el horario
// sincronizado de cada evento y lo marca needs_update (docs/11).
import { eq, inArray } from "drizzle-orm";
import { leagues, matches, teams } from "../../../drizzle/schema";
import type { Database } from "../db";
import { cierraPronostico, esFase, etiquetaFase, horarioArgentino, parsearHorarioArgentino, type Fase, type HorarioMostrado } from "./horario";

export const SOURCE_MANUAL = "manual";

export interface PartidoProde {
  id: string;
  fase: Fase | null;
  faseEtiqueta: string | null;
  horario: HorarioMostrado;
  local: { id: string; nombre: string };
  visitante: { id: string; nombre: string };
  estado: string | null;
}

export type Resultado =
  | { ok: true; partido: PartidoProde }
  | { ok: false; status: 400 | 404 | 409; error: string };

const error = (status: 400 | 404 | 409, codigo: string): Resultado => ({ ok: false, status, error: codigo });

type Fila = typeof matches.$inferSelect;

// Dos consultas en total (partidos y equipos), nunca una por partido: cuida las subrequests de Workers Free
async function armar(db: Database, filas: Fila[]): Promise<PartidoProde[]> {
  if (filas.length === 0) return [];
  const ids = [...new Set(filas.flatMap((m) => [m.homeTeamId, m.awayTeamId]))];
  const equipos = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, ids));
  const nombre = (tid: string) => equipos.find((e) => e.id === tid)?.name ?? "";
  return filas.map((m) => {
    const fase = esFase(m.round) ? m.round : null;
    return {
      id: m.id,
      fase,
      faseEtiqueta: fase ? etiquetaFase(fase) : null,
      horario: horarioArgentino(m.dateTime),
      local: { id: m.homeTeamId, nombre: nombre(m.homeTeamId) },
      visitante: { id: m.awayTeamId, nombre: nombre(m.awayTeamId) },
      estado: m.status,
    };
  });
}

async function leerPartido(db: Database, id: string): Promise<PartidoProde> {
  const filas = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
  return (await armar(db, filas))[0];
}

const textoNoVacio = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

export async function agregarCruce(db: Database, datos: Record<string, unknown>): Promise<Resultado> {
  const { leagueId, homeTeamId, awayTeamId, fase, venue } = datos;
  if (!textoNoVacio(leagueId) || !textoNoVacio(homeTeamId) || !textoNoVacio(awayTeamId)) return error(400, "faltan_datos");
  if (homeTeamId === awayTeamId) return error(400, "equipos_iguales");
  if (!esFase(fase)) return error(400, "fase_invalida");
  const dateTime = parsearHorarioArgentino(datos.horario);
  if (!dateTime) return error(400, "horario_invalido");
  if (venue !== undefined && venue !== null && typeof venue !== "string") return error(400, "sede_invalida");

  const [liga] = await db.select({ id: leagues.id }).from(leagues).where(eq(leagues.id, leagueId)).limit(1);
  if (!liga) return error(404, "liga_inexistente");
  const equipos = await db.select({ id: teams.id }).from(teams).where(inArray(teams.id, [homeTeamId, awayTeamId]));
  if (equipos.length !== 2) return error(404, "equipo_inexistente");

  const id = crypto.randomUUID();
  await db.insert(matches).values({
    id,
    externalId: `prode:${id}`,
    homeTeamId,
    awayTeamId,
    leagueId,
    dateTime,
    venue: venue ?? null,
    status: "scheduled",
    round: fase,
    source: SOURCE_MANUAL,
    updatedAt: new Date(),
  });
  return { ok: true, partido: await leerPartido(db, id) };
}

export async function corregirPartido(db: Database, datos: Record<string, unknown>): Promise<Resultado> {
  const { id, fase, horario } = datos;
  if (!textoNoVacio(id)) return error(400, "faltan_datos");
  if (fase === undefined && horario === undefined) return error(400, "sin_cambios");
  if (fase !== undefined && !esFase(fase)) return error(400, "fase_invalida");
  const dateTime = horario === undefined ? undefined : parsearHorarioArgentino(horario);
  if (dateTime === null) return error(400, "horario_invalido");

  const [m] = await db
    .select({ source: matches.source, dateTime: matches.dateTime, status: matches.status })
    .from(matches)
    .where(eq(matches.id, id))
    .limit(1);
  if (!m) return error(404, "partido_inexistente");
  // Un partido que trae el sync se corrige solo: el próximo sync pisaría el cambio manual
  if (m.source !== SOURCE_MANUAL) return error(409, "partido_no_manual");
  // Un partido empezado (hora del servidor o estado) no se toca: una nueva fecha reabriría los
  // pronósticos de un suspendido a mitad de partido (docs/37 §5)
  if (cierraPronostico(m, new Date())) return error(409, "partido_ya_empezado");

  await db
    .update(matches)
    .set({ ...(dateTime ? { dateTime } : {}), ...(fase !== undefined ? { round: fase } : {}), updatedAt: new Date() })
    .where(eq(matches.id, id));
  return { ok: true, partido: await leerPartido(db, id) };
}

// Cruces cargados para el prode, ordenados por horario
export async function listarCruces(db: Database): Promise<PartidoProde[]> {
  const filas = await db.select().from(matches).where(eq(matches.source, SOURCE_MANUAL)).orderBy(matches.dateTime);
  return armar(db, filas);
}
