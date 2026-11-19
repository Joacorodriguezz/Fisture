// Partidos del prode de playoffs: cruces cargados a mano sobre la tabla `matches` (sin migración).
// - source = 'manual' y external_id = 'prode:<uuid>': el sync de ESPN no los toca (actualiza por
//   external_id de su proveedor y nunca borra partidos).
// - round guarda la fase (octavos, cuartos, semifinal, final).
// - date_time es el único horario: el que se muestra y el que cierra el pronóstico (horario.ts).
// Corregir el horario alcanza para el calendario: la reconciliación compara date_time con el horario
// sincronizado de cada evento y lo marca needs_update (docs/11).
import { and, eq, gte, inArray, lte, ne } from "drizzle-orm";
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
  // Goles a los 90 minutos más adicionado; null hasta que el partido termina
  resultado: { local: number; visitante: number } | null;
}

export type Resultado =
  | { ok: true; partido: PartidoProde }
  // existente: solo en cruce_duplicado, el partido que ya está cargado (id y origen, nada más)
  | { ok: false; status: 400 | 404 | 409; error: string; existente?: { id: string; source: string } };

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
      resultado: m.homeScore !== null && m.awayScore !== null ? { local: m.homeScore, visitante: m.awayScore } : null,
    };
  });
}

async function leerPartido(db: Database, id: string): Promise<PartidoProde> {
  const filas = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
  return (await armar(db, filas))[0];
}

// Dos partidos de la misma liga y con el mismo local y visitante a menos de 6 h son el mismo cruce (de
// cualquier source: ESPN o manual). Evita dos eventos en el calendario de quien sigue al equipo y el
// chequeo duplicate_match (consistency.ts, que solo ve horarios idénticos). Equipos invertidos o más de
// 6 h de diferencia (ida y vuelta) son otro partido.
const VENTANA_DUPLICADO_MS = 6 * 60 * 60 * 1000;

async function buscarDuplicado(
  db: Database,
  c: { leagueId: string; homeTeamId: string; awayTeamId: string; dateTime: Date; excluirId?: string }
): Promise<{ id: string; source: string } | null> {
  const t = c.dateTime.getTime();
  const filas = await db
    .select({ id: matches.id, source: matches.source })
    .from(matches)
    .where(
      and(
        eq(matches.leagueId, c.leagueId),
        eq(matches.homeTeamId, c.homeTeamId),
        eq(matches.awayTeamId, c.awayTeamId),
        gte(matches.dateTime, new Date(t - VENTANA_DUPLICADO_MS)),
        lte(matches.dateTime, new Date(t + VENTANA_DUPLICADO_MS)),
        ...(c.excluirId ? [ne(matches.id, c.excluirId)] : [])
      )
    )
    .limit(1);
  return filas[0] ? { id: filas[0].id, source: filas[0].source ?? "" } : null;
}

const duplicado = (existente: { id: string; source: string }): Resultado => ({ ok: false, status: 409, error: "cruce_duplicado", existente });

const textoNoVacio =(v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

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

  const repetido = await buscarDuplicado(db, { leagueId, homeTeamId, awayTeamId, dateTime });
  if (repetido) return duplicado(repetido);

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

// Valores reales de matches.status
const ESTADOS = ["scheduled", "live", "finished", "postponed", "cancelled"] as const;
type Estado = (typeof ESTADOS)[number];
const esEstado = (v: unknown): v is Estado => typeof v === "string" && (ESTADOS as readonly string[]).includes(v);
// Goles a los 90 minutos más adicionado (sin alargue ni penales)
const esGoles = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 20;

// Estado y resultado: los goles van solo con finished, juntos; cualquier otro estado los deja en null
function validarEstado(datos: Record<string, unknown>): { cambios: Partial<Fila> } | { codigo: string } {
  const { status, homeScore, awayScore } = datos;
  const hayGoles = homeScore !== undefined || awayScore !== undefined;
  if (status === undefined) return hayGoles ? { codigo: "resultado_sin_finalizar" } : { cambios: {} };
  if (!esEstado(status)) return { codigo: "estado_invalido" };
  if (status !== "finished") return hayGoles ? { codigo: "resultado_sin_finalizar" } : { cambios: { status, homeScore: null, awayScore: null } };
  if (homeScore === undefined || awayScore === undefined) return { codigo: "faltan_goles" };
  if (!esGoles(homeScore) || !esGoles(awayScore)) return { codigo: "marcador_invalido" };
  return { cambios: { status, homeScore, awayScore } };
}

// Corrige horario/fase y/o carga estado y resultado de un cruce manual.
export async function corregirPartido(db: Database, datos: Record<string, unknown>): Promise<Resultado> {
  const { id, fase, horario } = datos;
  if (!textoNoVacio(id)) return error(400, "faltan_datos");
  if ([fase, horario, datos.status, datos.homeScore, datos.awayScore].every((v) => v === undefined)) return error(400, "sin_cambios");
  if (fase !== undefined && !esFase(fase)) return error(400, "fase_invalida");
  const dateTime = horario === undefined ? undefined : parsearHorarioArgentino(horario);
  if (dateTime === null) return error(400, "horario_invalido");
  const estado = validarEstado(datos);
  if ("codigo" in estado) return error(400, estado.codigo);

  const [m] = await db
    .select({ source: matches.source, dateTime: matches.dateTime, status: matches.status, leagueId: matches.leagueId, homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId })
    .from(matches)
    .where(eq(matches.id, id))
    .limit(1);
  if (!m) return error(404, "partido_inexistente");
  // Un partido que trae el sync se corrige solo: el próximo sync pisaría el cambio manual
  if (m.source !== SOURCE_MANUAL) return error(409, "partido_no_manual");
  // A un partido empezado (hora del servidor o estado) no se le cambia horario ni fase: una nueva
  // fecha reabriría los pronósticos de un suspendido a mitad de partido (docs/37 §5). Su estado y
  // resultado sí se cargan: es justamente cuando hacen falta.
  if ((dateTime || fase !== undefined) && cierraPronostico(m, new Date())) return error(409, "partido_ya_empezado");
  // Mover el horario no puede dejar el cruce encima de otro (manual o de ESPN)
  if (dateTime) {
    const repetido = await buscarDuplicado(db, { ...m, dateTime, excluirId: id });
    if (repetido) return duplicado(repetido);
  }

  await db
    .update(matches)
    .set({ ...(dateTime ? { dateTime } : {}), ...(fase !== undefined ? { round: fase } : {}), ...estado.cambios, updatedAt: new Date() })
    .where(eq(matches.id, id));
  return { ok: true, partido: await leerPartido(db, id) };
}

// Cruces cargados para el prode, ordenados por horario
export async function listarCruces(db: Database): Promise<PartidoProde[]> {
  const filas = await db.select().from(matches).where(eq(matches.source, SOURCE_MANUAL)).orderBy(matches.dateTime);
  return armar(db, filas);
}
