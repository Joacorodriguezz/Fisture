// Puntos del prode (docs/37 §2, §5 y §7). No se guardan: se calculan al leer, uniendo
// prode_predictions con los partidos del prode que tienen resultado confirmado. Así corregir un
// resultado (PATCH /api/admin/prode/partidos) recalcula todo sin duplicar nada, y no hay datos
// derivados que puedan quedar desfasados. Una consulta fija (dos con filtro de grupo), nunca una por
// usuario ni por partido: cuida las lecturas de D1 y las subrequests de Workers Free.
import { and, eq, inArray, isNotNull, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { matches, prodeGroupMembers, prodeMatches, prodePredictions } from "../../../drizzle/schema";
import type { Database } from "../db";
import { SOURCE_MANUAL } from "./partidos";
import { puntosDelPartido, PUNTOS_EXACTO, type Lado } from "./reglas";

export interface FiltroPuntos {
  /** Fase (`matches.round`): octavos, cuartos, semifinal o final. */
  fase?: string;
  /** Solo los miembros del grupo; incluye en 0 a los que todavía no puntuaron. */
  grupoId?: string;
  /** Solo ese usuario; aparece en 0 si todavía no puntuó. */
  userId?: string;
}

/**
 * Un pronóstico sobre un partido con resultado confirmado. `puntos` = `marcador` + `extra` (quién pasa).
 * `acierto` (incluye los exactos) es solo del marcador: acertó ganador o empate a los 90' (docs/40 R5).
 */
export interface PuntosPartido {
  userId: string;
  matchId: string;
  fase: string | null;
  puntos: number;
  marcador: number;
  extra: number;
  exacto: boolean;
  acierto: boolean;
}

/**
 * Totales de un usuario (mismos criterios que `Participante` en reglas.ts, sin el nombre). `pasa` cuenta
 * los partidos donde acertó quién pasa: solo informativo, no entra en el desempate (docs/40 R5).
 */
export interface PuntosUsuario {
  userId: string;
  puntos: number;
  exactos: number;
  aciertos: number;
  pasa: number;
}

export interface PuntosProde {
  partidos: PuntosPartido[];
  /** Ordenados por userId; el orden del ranking lo da `compararParticipantes`. */
  usuarios: PuntosUsuario[];
}

// Apagado total del resultado automático (docs/40 D3): con PRODE_RESULTADO_AUTO=off (rige tras un deploy) la
// lectura ignora todo lo automático, incluso lo ya confirmado. Cada handler lo lee y pasa el booleano.
export function resultadoAutoHabilitado(env: { PRODE_RESULTADO_AUTO?: string } | undefined): boolean {
  return env?.PRODE_RESULTADO_AUTO?.trim().toLowerCase() !== "off";
}

// Un automático puntúa solo si está confirmado (docs/40 §4.3)
const autoConfirmado = sql`${prodeMatches.autoConfirmadoAt} IS NOT NULL`;

// Marcador a 90' más adicionado efectivo (docs/37 §2, docs/40 D2): una sola expresión SQL para toda lectura
// (puntos, ranking y métricas). Precedencia, siempre por par (nunca un gol manual con uno automático):
// excluido > cruce manual (matches) > corrección manual completa > automático confirmado > ninguno.
// El marcador de ESPN (matches.home_score) no se usa en un adoptado: puede incluir alargue o penales.
function golEfectivo(
  auto: boolean,
  delManual: AnyColumn,
  manualCompleta: AnyColumn,
  delAutomatico: AnyColumn
) {
  const manualDelVinculo = sql`WHEN ${prodeMatches.homeGoals90} IS NOT NULL AND ${prodeMatches.awayGoals90} IS NOT NULL THEN ${manualCompleta}`;
  const automatico = auto
    ? sql`WHEN ${prodeMatches.autoHomeGoals90} IS NOT NULL AND ${prodeMatches.autoAwayGoals90} IS NOT NULL AND ${autoConfirmado} THEN ${delAutomatico}`
    : sql``;
  return sql<number | null>`CASE
  WHEN ${prodeMatches.excludedAt} IS NOT NULL THEN NULL
  WHEN ${matches.source} = ${SOURCE_MANUAL} THEN ${delManual}
  ${manualDelVinculo}
  ${automatico}
  ELSE NULL END`;
}

export const goles90Local = (auto = true) => golEfectivo(auto, matches.homeScore, prodeMatches.homeGoals90, prodeMatches.autoHomeGoals90);
export const goles90Visitante = (auto = true) => golEfectivo(auto, matches.awayScore, prodeMatches.awayGoals90, prodeMatches.autoAwayGoals90);

// Equipo que pasó efectivo (docs/40 R3), con el mismo orden: excluido; derivado del marcador efectivo si hay
// ganador; `pasa` manual; `auto_pasa` confirmado; si no, NULL. Sin marcador efectivo no hay equipo que pasó.
export const pasaEfectivo = (auto = true) => {
  const local = goles90Local(auto);
  const visitante = goles90Visitante(auto);
  const delAutomatico = auto
    ? sql`WHEN ${prodeMatches.autoPasa} IN ('home', 'away') AND ${autoConfirmado} THEN ${prodeMatches.autoPasa}`
    : sql``;
  return sql<Lado | null>`CASE
  WHEN ${prodeMatches.excludedAt} IS NOT NULL THEN NULL
  WHEN ${local} IS NULL OR ${visitante} IS NULL THEN NULL
  WHEN ${local} > ${visitante} THEN 'home'
  WHEN ${local} < ${visitante} THEN 'away'
  WHEN ${prodeMatches.pasa} IN ('home', 'away') THEN ${prodeMatches.pasa}
  ${delAutomatico}
  ELSE NULL END`;
};

/**
 * Solo puntúa un partido del prode `finished` con ambos goles a 90' cargados y con equipo que pasó
 * (docs/40 R4: un partido puntúa completo o no puntúa; un empate sin `pasa` queda en espera). Cancelado,
 * postergado, suspendido, sin jugar o con resultado incompleto no puntúa (aunque tenga un resultado
 * administrativo cargado, docs/37 §5). Sin pronóstico no hay fila: suma 0. `auto` en false
 * (PRODE_RESULTADO_AUTO=off, docs/40 D3) ignora todo lo automático.
 */
export async function puntosPorUsuario(db: Database, filtro: FiltroPuntos = {}, auto = true): Promise<PuntosProde> {
  const local = goles90Local(auto);
  const visitante = goles90Visitante(auto);
  const pasaReal = pasaEfectivo(auto);
  // Del prode es lo vinculado en prode_matches (innerJoin abajo): manual o adoptado de ESPN
  const condiciones: SQL[] = [
    eq(matches.status, "finished"),
    isNotNull(local),
    isNotNull(visitante),
    isNotNull(pasaReal),
  ];
  if (filtro.fase !== undefined) condiciones.push(eq(prodeMatches.fase, filtro.fase));
  if (filtro.userId !== undefined) condiciones.push(eq(prodePredictions.userId, filtro.userId));
  const delGrupo =
    filtro.grupoId !== undefined
      ? db.select({ userId: prodeGroupMembers.userId }).from(prodeGroupMembers).where(eq(prodeGroupMembers.groupId, filtro.grupoId))
      : null;
  if (delGrupo) condiciones.push(inArray(prodePredictions.userId, delGrupo));

  const [filas, miembros] = await Promise.all([
    db
      .select({
        userId: prodePredictions.userId,
        matchId: prodePredictions.matchId,
        homeGoals: prodePredictions.homeGoals,
        awayGoals: prodePredictions.awayGoals,
        pasaPronostico: prodePredictions.pasa,
        fase: prodeMatches.fase,
        homeScore: local,
        awayScore: visitante,
        pasaReal,
      })
      .from(prodePredictions)
      .innerJoin(matches, eq(matches.id, prodePredictions.matchId))
      .innerJoin(prodeMatches, eq(prodeMatches.matchId, matches.id))
      .where(and(...condiciones)),
    delGrupo ?? Promise.resolve([] as { userId: string }[]),
  ]);

  const partidos: PuntosPartido[] = filas.map((f) => {
    const pasaPronostico = f.pasaPronostico === "home" || f.pasaPronostico === "away" ? f.pasaPronostico : null;
    const { marcador, extra, total } = puntosDelPartido(
      { local: f.homeGoals, visitante: f.awayGoals, pasa: pasaPronostico },
      { local: f.homeScore!, visitante: f.awayScore! },
      f.pasaReal
    );
    return { userId: f.userId, matchId: f.matchId, fase: f.fase, puntos: total, marcador, extra, exacto: marcador === PUNTOS_EXACTO, acierto: marcador > 0 };
  });

  // Participantes que deben figurar aunque no hayan puntuado (se sumaron tarde o no pronosticaron)
  const base = delGrupo ? miembros.map((m) => m.userId) : filtro.userId !== undefined ? [filtro.userId] : [];
  return { partidos, usuarios: totalizar(partidos, base) };
}

/** Agrega los puntos por usuario. `base` son usuarios que figuran en 0 si no tienen partidos. */
export function totalizar(partidos: PuntosPartido[], base: string[] = []): PuntosUsuario[] {
  const totales = new Map<string, PuntosUsuario>();
  const de = (userId: string) => {
    let t = totales.get(userId);
    if (!t) totales.set(userId, (t = { userId, puntos: 0, exactos: 0, aciertos: 0, pasa: 0 }));
    return t;
  };
  for (const userId of base) de(userId);
  for (const p of partidos) {
    const t = de(p.userId);
    t.puntos += p.puntos;
    if (p.exacto) t.exactos++;
    if (p.acierto) t.aciertos++;
    if (p.extra > 0) t.pasa++;
  }
  return [...totales.values()].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}
