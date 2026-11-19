// Puntos del prode (docs/37 §2, §5 y §7). No se guardan: se calculan al leer, uniendo
// prode_predictions con los partidos del prode que tienen resultado confirmado. Así corregir un
// resultado (PATCH /api/admin/prode/partidos) recalcula todo sin duplicar nada, y no hay datos
// derivados que puedan quedar desfasados. Una consulta fija (dos con filtro de grupo), nunca una por
// usuario ni por partido: cuida las lecturas de D1 y las subrequests de Workers Free.
import { and, eq, inArray, isNotNull, type SQL } from "drizzle-orm";
import { matches, prodeGroupMembers, prodePredictions } from "../../../drizzle/schema";
import type { Database } from "../db";
import { SOURCE_MANUAL } from "./partidos";
import { calcularPuntos, PUNTOS_EXACTO } from "./reglas";

export interface FiltroPuntos {
  /** Fase (`matches.round`): octavos, cuartos, semifinal o final. */
  fase?: string;
  /** Solo los miembros del grupo; incluye en 0 a los que todavía no puntuaron. */
  grupoId?: string;
  /** Solo ese usuario; aparece en 0 si todavía no puntuó. */
  userId?: string;
}

/** Un pronóstico sobre un partido con resultado confirmado. `acierto` incluye los exactos. */
export interface PuntosPartido {
  userId: string;
  matchId: string;
  fase: string | null;
  puntos: number;
  exacto: boolean;
  acierto: boolean;
}

/** Totales de un usuario (mismos criterios que `Participante` en reglas.ts, sin el nombre). */
export interface PuntosUsuario {
  userId: string;
  puntos: number;
  exactos: number;
  aciertos: number;
}

export interface PuntosProde {
  partidos: PuntosPartido[];
  /** Ordenados por userId; el orden del ranking lo da `compararParticipantes`. */
  usuarios: PuntosUsuario[];
}

/**
 * Solo puntúa un partido del prode `finished` con ambos goles cargados. Cancelado, postergado,
 * suspendido, sin jugar o con resultado incompleto no puntúa (aunque tenga un resultado
 * administrativo cargado, docs/37 §5). Sin pronóstico no hay fila: suma 0.
 */
export async function puntosPorUsuario(db: Database, filtro: FiltroPuntos = {}): Promise<PuntosProde> {
  const condiciones: SQL[] = [
    eq(matches.source, SOURCE_MANUAL),
    eq(matches.status, "finished"),
    isNotNull(matches.homeScore),
    isNotNull(matches.awayScore),
  ];
  if (filtro.fase !== undefined) condiciones.push(eq(matches.round, filtro.fase));
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
        fase: matches.round,
        homeScore: matches.homeScore,
        awayScore: matches.awayScore,
      })
      .from(prodePredictions)
      .innerJoin(matches, eq(matches.id, prodePredictions.matchId))
      .where(and(...condiciones)),
    delGrupo ?? Promise.resolve([] as { userId: string }[]),
  ]);

  const partidos: PuntosPartido[] = filas.map((f) => {
    const puntos = calcularPuntos({ local: f.homeGoals, visitante: f.awayGoals }, { local: f.homeScore!, visitante: f.awayScore! });
    return { userId: f.userId, matchId: f.matchId, fase: f.fase, puntos, exacto: puntos === PUNTOS_EXACTO, acierto: puntos > 0 };
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
    if (!t) totales.set(userId, (t = { userId, puntos: 0, exactos: 0, aciertos: 0 }));
    return t;
  };
  for (const userId of base) de(userId);
  for (const p of partidos) {
    const t = de(p.userId);
    t.puntos += p.puntos;
    if (p.exacto) t.exactos++;
    if (p.acierto) t.aciertos++;
  }
  return [...totales.values()].sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
}
