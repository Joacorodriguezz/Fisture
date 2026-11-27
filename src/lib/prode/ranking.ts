// Rankings del prode (docs/37 §6): general, por fase y por grupo privado. Los puntos salen de
// `puntosPorUsuario` (se calculan al leer, así una corrección de resultado reordena sola). Los
// nombres se leen en paralelo, en la misma ronda de consultas a D1 (subconsulta, no una lista de
// ids: D1 acota los parámetros por sentencia). La salida nunca lleva email ni id de usuario.
import { inArray, eq } from "drizzle-orm";
import { prodeGroupMembers, prodeMatches, prodePredictions, users } from "../../../drizzle/schema";
import type { Database } from "../db";
import { NOMBRE_GENERICO } from "./grupos";
import { puntosPorUsuario } from "./puntos";
import { compararParticipantes } from "./reglas";

export interface FiltroRanking {
  /** Fase (`matches.round`); sin fase, el acumulado. */
  fase?: string;
  /** Solo los integrantes del grupo (los que no puntuaron figuran en 0). */
  grupoId?: string;
  /** Usuario que mira: su fila sale con `esVos`. No filtra. */
  vos?: string;
}

export interface FilaRanking {
  posicion: number;
  nombre: string;
  puntos: number;
  exactos: number;
  aciertos: number;
  esVos: boolean;
}

/**
 * Ranking ordenado con `compararParticipantes`. La posición es de competición estándar (1, 2, 2, 4):
 * se comparte cuando coinciden puntos, exactos y aciertos; el nombre solo ordena la tabla (docs/37 §6).
 * El general incluye a quien tiene al menos un pronóstico sobre un partido del prode (de la fase, si se filtra),
 * tenga o no resultado confirmado: quien aún no puntuó figura en 0. El de grupo, a todos los integrantes.
 */
export async function rankingProde(db: Database, filtro: FiltroRanking = {}): Promise<FilaRanking[]> {
  const { fase, grupoId, vos } = filtro;
  const ids =
    grupoId !== undefined
      ? db.select({ userId: prodeGroupMembers.userId }).from(prodeGroupMembers).where(eq(prodeGroupMembers.groupId, grupoId))
      : db
          .selectDistinct({ userId: prodePredictions.userId })
          .from(prodePredictions)
          .innerJoin(prodeMatches, eq(prodeMatches.matchId, prodePredictions.matchId))
          .where(fase !== undefined ? eq(prodeMatches.fase, fase) : undefined);

  const [{ usuarios }, nombres] = await Promise.all([
    puntosPorUsuario(db, { fase, grupoId }),
    db.select({ id: users.id, nombre: users.displayName }).from(users).where(inArray(users.id, ids)),
  ]);

  const nombrePor = new Map(nombres.map((n) => [n.id, n.nombre?.trim() || NOMBRE_GENERICO]));
  // Quien pronosticó pero no tiene partidos con resultado no está en `usuarios`: entra en 0
  const conPuntos = new Set(usuarios.map((u) => u.userId));
  const en0 = nombres.filter((n) => !conPuntos.has(n.id)).map((n) => ({ userId: n.id, puntos: 0, exactos: 0, aciertos: 0, pasa: 0 }));
  const ordenados = [...usuarios, ...en0]
    .map((u) => ({ ...u, nombre: nombrePor.get(u.userId) ?? NOMBRE_GENERICO }))
    .sort(compararParticipantes);

  let posicion = 0;
  return ordenados.map((u, i) => {
    const previo = ordenados[i - 1];
    if (!previo || previo.puntos !== u.puntos || previo.exactos !== u.exactos || previo.aciertos !== u.aciertos) posicion = i + 1;
    return { posicion, nombre: u.nombre, puntos: u.puntos, exactos: u.exactos, aciertos: u.aciertos, esVos: u.userId === vos };
  });
}

/** Tope de filas que devuelve la API; la fila propia va aparte si queda fuera. */
export const TOPE_RANKING = 100;

export interface RespuestaRanking {
  fase: string | null;
  total: number;
  filas: FilaRanking[];
  yo: FilaRanking | null;
}

export function recortarRanking(filas: FilaRanking[], fase: string | undefined): RespuestaRanking {
  return { fase: fase ?? null, total: filas.length, filas: filas.slice(0, TOPE_RANKING), yo: filas.find((f) => f.esVos) ?? null };
}
