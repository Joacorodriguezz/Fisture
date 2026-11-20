-- Migration: 0021_prode_resultado_90
-- Description: resultado a los 90 minutos y cierre irreversible de los partidos del prode (docs/37).
-- - home_goals_90 / away_goals_90: resultado a los 90 minutos más adicionado, confirmado a mano por el
--   admin para los partidos adoptados de ESPN (el marcador de ESPN puede incluir alargue, penales o un
--   resultado administrativo). Los cruces manuales siguen puntuando con matches.home_score/away_score.
-- - closed_at (ms): instante en que se observó que el partido empezó. Una vez fijado, el pronóstico no
--   se reabre aunque el sync traiga una nueva fecha futura (suspendido y reprogramado, docs/37 §5).
-- Solo aditiva (columnas nullable): el código anterior no las lee.

ALTER TABLE prode_matches ADD COLUMN home_goals_90 INTEGER;
ALTER TABLE prode_matches ADD COLUMN away_goals_90 INTEGER;
ALTER TABLE prode_matches ADD COLUMN closed_at INTEGER;
