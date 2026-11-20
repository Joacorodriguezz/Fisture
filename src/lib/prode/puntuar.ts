// Puntaje del prode en el sync (docs/37 §3.5). Un solo batch de D1 (una subrequest) con dos UPDATE:
// 1. Puntúa los pronósticos de partidos terminados con los dos goles cargados que todavía no tienen
//    puntos, o cuyo partido cambió después de puntuarse (corrección del resultado: el sync solo toca
//    matches.updated_at cuando algo cambió).
// 2. Anula los puntos de los que dejaron de estar terminados o perdieron el marcador.
// Solo mira los partidos de los últimos 30 días (idx_matches_date): el costo no crece con la historia.
import type { D1Database } from "@cloudflare/workers-types";
import { sqlPuntos } from "./reglas";

export const VENTANA_PUNTAJE_DIAS = 30;

export interface ResultadoPuntaje {
  puntuados: number;
  anulados: number;
}

const TERMINADO = "COALESCE(m.status, '') = 'finished' AND m.home_score IS NOT NULL AND m.away_score IS NOT NULL";

export async function puntuarPronosticos(DB: D1Database, ahora: Date = new Date()): Promise<ResultadoPuntaje> {
  const t = Math.floor(ahora.getTime() / 1000);
  const desde = t - VENTANA_PUNTAJE_DIAS * 86_400;
  const [puntuar, anular] = await DB.batch([
    DB.prepare(
      `UPDATE prode_predictions
        SET points = ${sqlPuntos("prode_predictions.home_goals", "prode_predictions.away_goals", "m.home_score", "m.away_score")},
          scored_at = ?1
        FROM matches AS m
        WHERE m.id = prode_predictions.match_id
          AND m.date_time >= ?2 AND m.date_time <= ?1
          AND ${TERMINADO}
          AND (prode_predictions.scored_at IS NULL OR prode_predictions.scored_at < m.updated_at)`
    ).bind(t, desde),
    DB.prepare(
      `UPDATE prode_predictions SET points = NULL, scored_at = NULL
        FROM matches AS m
        WHERE m.id = prode_predictions.match_id
          AND m.date_time >= ?1
          AND prode_predictions.points IS NOT NULL
          AND NOT (${TERMINADO})`
    ).bind(desde),
  ]);
  return { puntuados: puntuar.meta.changes, anulados: anular.meta.changes };
}
