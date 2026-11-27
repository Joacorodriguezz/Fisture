// Partidos del prode de playoffs. Un partido es del prode si tiene fila en prode_matches (migración
// 0020), con su fase, venga de donde venga:
// - Cruce cargado a mano: source = 'manual' y external_id = 'prode:<uuid>'; round repite la fase. Si
//   después el sync de ESPN trae el mismo partido, lo reemplaza (reemplazarCrucesManuales, sync.ts).
// - Partido de ESPN adoptado ({adoptar}): lo gobierna el sync (horario, estado, resultado); acá no se edita.
// - date_time es el único horario: el que se muestra y el que cierra el pronóstico (horario.ts).
// Corregir el horario alcanza para el calendario: la reconciliación compara date_time con el horario
// sincronizado de cada evento y lo marca needs_update (docs/11).
import { and, eq, exists, gt, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import { leagues, matches, prodeMatches, teams } from "../../../drizzle/schema";
import type { Database } from "../db";
import { enEsperaSql, goles90Local, goles90Visitante, pasaEfectivo } from "./puntos";
import { ladoQuePasa, SOURCE_MANUAL, type Lado } from "./reglas";
import { cierraPronostico, ESTADOS_EMPEZADO, esFase, etiquetaFase, horarioArgentino, parsearHorarioArgentino, type Fase, type HorarioMostrado } from "./horario";

export { SOURCE_MANUAL };

export interface PartidoProde {
  id: string;
  fase: Fase | null;
  faseEtiqueta: string | null;
  horario: HorarioMostrado;
  local: { id: string; nombre: string };
  visitante: { id: string; nombre: string };
  estado: string | null;
  // Marcador a 90' más adicionado efectivo (puntos.ts: excluido, manual, automático confirmado); null sin dato
  resultado: { local: number; visitante: number } | null;
  // Equipo que pasó efectivo (docs/40 R3): con ganador a 90', el ganador; con empate, el manual o el automático
  // confirmado. null si no se sabe
  pasa: Lado | null;
  // Cierre definitivo del pronóstico (prode_matches.closed_at, ms): se vio empezar; no se reabre
  cerradoEn: number | null;
}

/** Lo que ve el administrador (docs/40 D5). Nada de esto llega al participante (pronosticos.ts). */
export interface PartidoAdmin extends PartidoProde {
  // Lo último que el sync leyó de ESPN, confirmado o no; null si no hay dato automático
  automatico: { local: number | null; visitante: number | null; pasa: Lado | null; regla: string | null; confirmadoEn: number | null } | null;
  excluido: boolean;
  // Terminado hace rato y sin resultado que puntúe: requiere una corrección o una exclusión
  enEspera: boolean;
  // Última pasada del sync tras el final (ms)
  pasadaEn: number | null;
}

export type Resultado =
  | { ok: true; partido: PartidoAdmin }
  // existente: solo en cruce_duplicado, el partido que ya está cargado (id y origen, nada más)
  | { ok: false; status: 400 | 404 | 409; error: string; existente?: { id: string; source: string } };

const error = (status: 400 | 404 | 409, codigo: string): Resultado => ({ ok: false, status, error: codigo });

type Fila = typeof matches.$inferSelect;

type Marcador90 = { local: number; visitante: number };
const marcador90 = (local: number | null, visitante: number | null): Marcador90 | null =>
  local !== null && visitante !== null ? { local, visitante } : null;

const esLado = (v: unknown): v is Lado => v === "home" || v === "away";

// Partidos del prode con su resultado efectivo, calculado por las mismas expresiones SQL que puntúan
function consultaPartidos(db: Database, auto: boolean, ahora = Date.now()) {
  return db
    .select({
      m: matches,
      v: prodeMatches,
      local90: goles90Local(auto),
      visitante90: goles90Visitante(auto),
      pasaReal: pasaEfectivo(auto),
      espera: enEsperaSql(auto, ahora),
    })
    .from(matches)
    .innerJoin(prodeMatches, eq(prodeMatches.matchId, matches.id));
}
type FilaProde = Awaited<ReturnType<typeof consultaPartidos>>[number];

function automaticoDe(v: typeof prodeMatches.$inferSelect): PartidoAdmin["automatico"] {
  if (v.autoVistoAt === null && v.autoHomeGoals90 === null && v.autoPasa === null) return null;
  return {
    local: v.autoHomeGoals90,
    visitante: v.autoAwayGoals90,
    pasa: esLado(v.autoPasa) ? v.autoPasa : null,
    regla: v.autoRegla,
    confirmadoEn: v.autoConfirmadoAt,
  };
}

// Dos consultas en total (partidos y equipos), nunca una por partido: cuida las subrequests de Workers Free
async function armar(db: Database, filas: FilaProde[]): Promise<PartidoAdmin[]> {
  if (filas.length === 0) return [];
  const ids = [...new Set(filas.flatMap(({ m }) => [m.homeTeamId, m.awayTeamId]))];
  const equipos = await db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, ids));
  const nombre = (tid: string) => equipos.find((e) => e.id === tid)?.name ?? "";
  return filas.map(({ m, v, local90, visitante90, pasaReal, espera }) => {
    // La fase sale del vínculo (en un partido de ESPN, matches.round es la del proveedor)
    const fase = esFase(v.fase) ? v.fase : null;
    return {
      id: m.id,
      fase,
      faseEtiqueta: fase ? etiquetaFase(fase) : null,
      horario: horarioArgentino(m.dateTime),
      local: { id: m.homeTeamId, nombre: nombre(m.homeTeamId) },
      visitante: { id: m.awayTeamId, nombre: nombre(m.awayTeamId) },
      estado: m.status,
      resultado: marcador90(local90, visitante90),
      pasa: pasaReal,
      cerradoEn: v.closedAt,
      automatico: automaticoDe(v),
      excluido: v.excludedAt !== null,
      enEspera: Boolean(espera),
      pasadaEn: v.pasadaAt,
    };
  });
}

async function leerPartido(db: Database, id: string, auto: boolean): Promise<PartidoAdmin> {
  const filas = await consultaPartidos(db, auto).where(eq(matches.id, id)).limit(1);
  return (await armar(db, filas))[0];
}

// Dos partidos de la misma liga y con el mismo local y visitante a menos de 6 h son el mismo cruce (de
// cualquier source: ESPN o manual). Evita dos eventos en el calendario de quien sigue al equipo y el
// chequeo duplicate_match (consistency.ts, que solo ve horarios idénticos). Equipos invertidos o más de
// 6 h de diferencia (ida y vuelta) son otro partido.
export const VENTANA_DUPLICADO_MS = 6 * 60 * 60 * 1000;

interface Cruce {
  homeTeamId: string;
  awayTeamId: string;
  dateTime: Date;
}

// Misma regla que buscarDuplicado, en memoria (la usa el sync para reemplazar cruces manuales por los de
// ESPN sin consultar partido por partido). La liga la filtra quien llama.
export function esMismoCruce(a: Cruce, b: Cruce): boolean {
  return (
    a.homeTeamId === b.homeTeamId &&
    a.awayTeamId === b.awayTeamId &&
    Math.abs(a.dateTime.getTime() - b.dateTime.getTime()) < VENTANA_DUPLICADO_MS
  );
}

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
        // Menos de 6 h, estricto: a 6:00 exactas es otro partido (igual que esMismoCruce)
        gt(matches.dateTime, new Date(t - VENTANA_DUPLICADO_MS)),
        lt(matches.dateTime, new Date(t + VENTANA_DUPLICADO_MS)),
        ...(c.excluirId ? [ne(matches.id, c.excluirId)] : [])
      )
    )
    .limit(1);
  return filas[0] ? { id: filas[0].id, source: filas[0].source ?? "" } : null;
}

const duplicado = (existente: { id: string; source: string }): Resultado => ({ ok: false, status: 409, error: "cruce_duplicado", existente });

const textoNoVacio =(v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

// POST: con {adoptar} suma al prode un partido existente (de ESPN); si no, carga un cruce manual
export async function agregarCruce(db: Database, datos: Record<string, unknown>, auto = true): Promise<Resultado> {
  if (datos.adoptar !== undefined) return adoptarPartido(db, datos, auto);
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
  const ahora = new Date();
  await db.batch([
    db.insert(matches).values({
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
      updatedAt: ahora,
    }),
    db.insert(prodeMatches).values({ matchId: id, fase, createdAt: ahora }),
  ]);
  return { ok: true, partido: await leerPartido(db, id, auto) };
}

// El adaptador de ESPN suma "Ida" o "Vuelta" a matches.round cuando el evento trae `leg` (espn.ts)
const RONDA_CON_VUELTA = /(?:^|\s)(Ida|Vuelta)$/;

// Suma al prode un partido que ya existe: el de ESPN que agregarCruce informó como cruce_duplicado.
// No toca la fila de matches: horario, estado y resultado los sigue gobernando el sync.
async function adoptarPartido(db: Database, datos: Record<string, unknown>, auto: boolean): Promise<Resultado> {
  const { adoptar, fase } = datos;
  if (!textoNoVacio(adoptar)) return error(400, "faltan_datos");
  if (!esFase(fase)) return error(400, "fase_invalida");
  const [m] = await db.select({ id: matches.id, round: matches.round }).from(matches).where(eq(matches.id, adoptar)).limit(1);
  if (!m) return error(404, "partido_inexistente");
  // "Quién pasa" se define por partido único (docs/40 R6): ESPN marca la ida y la vuelta en la ronda
  if (m.round && RONDA_CON_VUELTA.test(m.round)) return error(409, "partido_con_vuelta");
  const insertado = await db
    .insert(prodeMatches)
    .values({ matchId: adoptar, fase, createdAt: new Date() })
    .onConflictDoNothing()
    .returning({ id: prodeMatches.matchId });
  if (insertado.length === 0) return error(409, "ya_en_prode");
  return { ok: true, partido: await leerPartido(db, adoptar, auto) };
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
export async function corregirPartido(db: Database, datos: Record<string, unknown>, auto = true): Promise<Resultado> {
  if (datos.excluir !== undefined) return fijarExclusion(db, datos, auto);
  if (datos.homeGoals90 !== undefined || datos.awayGoals90 !== undefined) return fijarResultado90(db, datos, auto);
  if (datos.pasa !== undefined) return fijarPasa(db, datos, auto);
  const { id, fase, horario } = datos;
  if (!textoNoVacio(id)) return error(400, "faltan_datos");
  if ([fase, horario, datos.status, datos.homeScore, datos.awayScore].every((v) => v === undefined)) return error(400, "sin_cambios");
  if (fase !== undefined && !esFase(fase)) return error(400, "fase_invalida");
  const dateTime = horario === undefined ? undefined : parsearHorarioArgentino(horario);
  if (dateTime === null) return error(400, "horario_invalido");
  const estado = validarEstado(datos);
  if ("codigo" in estado) return error(400, estado.codigo);

  const [m] = await db
    .select({ source: matches.source, dateTime: matches.dateTime, status: matches.status, leagueId: matches.leagueId, homeTeamId: matches.homeTeamId, awayTeamId: matches.awayTeamId, closedAt: prodeMatches.closedAt })
    .from(matches)
    .leftJoin(prodeMatches, eq(prodeMatches.matchId, matches.id))
    .where(eq(matches.id, id))
    .limit(1);
  if (!m) return error(404, "partido_inexistente");
  // Un partido que trae el sync se corrige solo: el próximo sync pisaría el cambio manual
  if (m.source !== SOURCE_MANUAL) return error(409, "partido_no_manual");
  // A un partido empezado (hora del servidor o estado) no se le cambia horario ni fase: una nueva
  // fecha reabriría los pronósticos de un suspendido a mitad de partido (docs/37 §5). Su estado y
  // resultado sí se cargan: es justamente cuando hacen falta.
  const ahora = new Date();
  if ((dateTime || fase !== undefined) && cierraPronostico(m, ahora)) return error(409, "partido_ya_empezado");
  // Un resultado antes de la hora de inicio es un error de carga: puntuaría un partido sin jugar
  if (estado.cambios.status === "finished" && (dateTime ?? m.dateTime).getTime() > ahora.getTime()) return error(409, "partido_no_empezado");
  // Mover el horario no puede dejar el cruce encima de otro (manual o de ESPN)
  if (dateTime) {
    const repetido = await buscarDuplicado(db, { ...m, dateTime, excluirId: id });
    if (repetido) return duplicado(repetido);
  }

  // Las decisiones de arriba valen para la fila leída. Si el sync la cambió entre medio (p. ej. la pasó a
  // live), la escritura no aplica: 409 partido_cambio y el admin reintenta con la fila nueva
  const vigente = and(eq(matches.id, id), sql`${matches.status} IS ${m.status}`, eq(matches.dateTime, m.dateTime));
  const cambio = db
    .update(matches)
    .set({ ...(dateTime ? { dateTime } : {}), ...(fase !== undefined ? { round: fase } : {}), ...estado.cambios, updatedAt: new Date() })
    .where(vigente);
  // La fase que vale es la del vínculo; round la repite en los manuales
  // Un `pasa` solo vale con un empate a 90': si el estado cambia y el resultado deja de ser empate (o se
  // borra), el que había queda huérfano y se retira
  const sigueEmpate = estado.cambios.status === "finished" && estado.cambios.homeScore === estado.cambios.awayScore;
  const retiraPasa = estado.cambios.status !== undefined && !sigueEmpate;
  const vinculo = [
    ...(fase !== undefined ? [{ fase }] : []),
    ...(retiraPasa ? [{ pasa: null }] : []),
  ].map((set) => db.update(prodeMatches).set(set).where(and(eq(prodeMatches.matchId, id), exists(db.select({ id: matches.id }).from(matches).where(vigente)))));
  // Cierre definitivo si la fila vigente muestra que empezó, antes o después del cambio: no se reabre
  // (docs/37 §5). Se decide en SQL, no con la lectura, para no perder un live que escribió el sync.
  const [, ...resultados] = await db.batch([cerrarSiEmpezo(db, id, ahora), ...vinculo, cambio, cerrarSiEmpezo(db, id, ahora)]);
  const escrito = resultados[vinculo.length] as D1Result;
  if (!escrito.meta.changes) return error(409, "partido_cambio");
  return { ok: true, partido: await leerPartido(db, id, auto) };
}

// Fija prode_matches.closed_at si el partido, tal como está en la fila vigente, ya empezó (idempotente)
function cerrarSiEmpezo(db: Database, id: string, ahora: Date) {
  const empezado = db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.id, id), or(lte(matches.dateTime, ahora), inArray(matches.status, [...ESTADOS_EMPEZADO]))));
  return db
    .update(prodeMatches)
    .set({ closedAt: ahora.getTime() })
    .where(and(eq(prodeMatches.matchId, id), isNull(prodeMatches.closedAt), exists(empezado)));
}

// Fija prode_matches.closed_at si todavía no estaba (idempotente)
function cerrar(db: Database, id: string, ahora: Date) {
  return db
    .update(prodeMatches)
    .set({ closedAt: ahora.getTime() })
    .where(and(eq(prodeMatches.matchId, id), isNull(prodeMatches.closedAt)));
}

// Con ganador a 90' el equipo que pasó es ese; un `pasa` que lo contradice es inconsistente (docs/40 R3)
function contradiceGanador(resultado: { local: number; visitante: number } | null, pasa: Lado | null): boolean {
  return pasa !== null && resultado !== null && resultado.local !== resultado.visitante && ladoQuePasa(resultado, null) !== pasa;
}

// {id, excluir}: un partido excluido no puntúa, tenga el resultado que tenga (resultado administrativo,
// docs/40 D2); excluir: false lo deshace. Vale para manuales y adoptados, y va solo.
async function fijarExclusion(db: Database, datos: Record<string, unknown>, auto: boolean): Promise<Resultado> {
  const { id, excluir } = datos;
  if (!textoNoVacio(id)) return error(400, "faltan_datos");
  if (Object.keys(datos).some((k) => k !== "id" && k !== "excluir")) return error(400, "cambios_mezclados");
  if (typeof excluir !== "boolean") return error(400, "excluir_invalido");
  const escrito = await db
    .update(prodeMatches)
    // Idempotente: excluir de nuevo conserva la fecha de la primera exclusión
    .set({ excludedAt: excluir ? sql`COALESCE(${prodeMatches.excludedAt}, ${Date.now()})` : null })
    .where(eq(prodeMatches.matchId, id))
    .returning({ id: prodeMatches.matchId });
  if (escrito.length === 0) return error(404, "partido_inexistente");
  return { ok: true, partido: await leerPartido(db, id, auto) };
}

// Resultado a los 90 minutos de un partido adoptado de ESPN ({id, homeGoals90, awayGoals90, pasa?}). Se guarda
// en el vínculo, sin tocar la fila de matches (la gobierna el sync). Puntúa cuando además el partido
// está finished y se sabe quién pasó (puntos.ts). En un manual el resultado a 90' es el de matches: 409
// partido_manual. `pasa` (home | away | null) vale con empate; con ganador que lo contradice, 409 pasa_inconsistente.
async function fijarResultado90(db: Database, datos: Record<string, unknown>, auto: boolean): Promise<Resultado> {
  const { id, homeGoals90, awayGoals90, pasa } = datos;
  if (!textoNoVacio(id)) return error(400, "faltan_datos");
  const otros = Object.keys(datos).filter((k) => !["id", "homeGoals90", "awayGoals90", "pasa"].includes(k));
  if (otros.length > 0) return error(400, "cambios_mezclados");
  if (homeGoals90 === undefined || awayGoals90 === undefined) return error(400, "faltan_goles");
  // null, null retira la corrección manual (y su pasa): vuelve a valer el automático (docs/40 D2)
  const retira = homeGoals90 === null && awayGoals90 === null;
  if (!retira && (!esGoles(homeGoals90) || !esGoles(awayGoals90))) return error(400, "marcador_invalido");
  if (pasa !== undefined && pasa !== null && !esLado(pasa)) return error(400, "pasa_invalido");
  if (retira && esLado(pasa)) return error(400, "cambios_mezclados");

  const [m] = await db
    .select({ source: matches.source, dateTime: matches.dateTime })
    .from(matches)
    .innerJoin(prodeMatches, eq(prodeMatches.matchId, matches.id))
    .where(eq(matches.id, id))
    .limit(1);
  if (!m) return error(404, "partido_inexistente");
  if (m.source === SOURCE_MANUAL) return error(409, "partido_manual");
  if (retira) {
    await db.update(prodeMatches).set({ homeGoals90: null, awayGoals90: null, pasa: null }).where(eq(prodeMatches.matchId, id));
    return { ok: true, partido: await leerPartido(db, id, auto) };
  }
  if (contradiceGanador({ local: homeGoals90 as number, visitante: awayGoals90 as number }, (pasa as Lado | null | undefined) ?? null)) return error(409, "pasa_inconsistente");
  const ahora = new Date();
  if (m.dateTime.getTime() > ahora.getTime()) return error(409, "partido_no_empezado");

  // Ya empezó (su hora pasó): de paso queda el cierre definitivo
  await db.batch([
    db.update(prodeMatches).set({ homeGoals90: homeGoals90 as number, awayGoals90: awayGoals90 as number, ...(pasa !== undefined ? { pasa: pasa as Lado | null } : homeGoals90 !== awayGoals90 ? { pasa: null } : {}) }).where(eq(prodeMatches.matchId, id)),
    cerrar(db, id, ahora),
  ]);
  return { ok: true, partido: await leerPartido(db, id, auto) };
}

// Equipo que pasó de un partido empatado a 90' ({id, pasa}), manual o adoptado. `pasa: null` lo retira. Con un
// ganador a 90' el equipo que pasó se deriva: un `pasa` que lo contradice responde 409 pasa_inconsistente.
async function fijarPasa(db: Database, datos: Record<string, unknown>, auto: boolean): Promise<Resultado> {
  const { id, pasa } = datos;
  if (!textoNoVacio(id)) return error(400, "faltan_datos");
  if (Object.keys(datos).some((k) => k !== "id" && k !== "pasa")) return error(400, "cambios_mezclados");
  if (pasa !== null && !esLado(pasa)) return error(400, "pasa_invalido");

  // El marcador vigente, también el de un excluido: sobre un ganador no se guarda quién pasa
  const [f] = await db
    .select({ dateTime: matches.dateTime, local90: goles90Local(auto, false), visitante90: goles90Visitante(auto, false) })
    .from(matches)
    .innerJoin(prodeMatches, eq(prodeMatches.matchId, matches.id))
    .where(eq(matches.id, id))
    .limit(1);
  if (!f) return error(404, "partido_inexistente");
  const r90 = marcador90(f.local90, f.visitante90);
  if (contradiceGanador(r90, pasa)) return error(409, "pasa_inconsistente");
  // Con un ganador a 90' el equipo que pasó se deriva: no se guarda, para que no reaparezca si el resultado se corrige a empate
  const pasaAGuardar = r90 !== null && r90.local !== r90.visitante ? null : pasa;
  if (pasa === null) {
    await db.update(prodeMatches).set({ pasa: null }).where(eq(prodeMatches.matchId, id));
    return { ok: true, partido: await leerPartido(db, id, auto) };
  }
  const ahora = new Date();
  if (f.dateTime.getTime() > ahora.getTime()) return error(409, "partido_no_empezado");
  await db.batch([db.update(prodeMatches).set({ pasa: pasaAGuardar }).where(eq(prodeMatches.matchId, id)), cerrar(db, id, ahora)]);
  return { ok: true, partido: await leerPartido(db, id, auto) };
}

// Partidos del prode (manuales y adoptados), ordenados por horario
export async function listarCruces(db: Database, auto = true): Promise<PartidoAdmin[]> {
  const filas = await consultaPartidos(db, auto).orderBy(matches.dateTime);
  return armar(db, filas);
}
