-- Migration: 0023_prode_resultado_auto
-- Description: automatización del resultado del prode (docs/40 D2). Columnas propias para lo que lee el
-- sync de ESPN, separadas de la corrección manual (home_goals_90, away_goals_90, pasa): el sync nunca
-- escribe las manuales, así no puede pisar una corrección.
-- - auto_home_goals_90, auto_away_goals_90, auto_pasa, auto_regla: marcador a 90', equipo que pasó y
--   regla ('A' | 'B') con que salieron (evidencia).
-- - auto_visto_at, auto_confirmado_at (ms): primera lectura de los valores actuales y momento en que se
--   cumplió la confirmación (docs/40 §4.3). Solo puntúa lo confirmado.
-- - excluded_at (ms): el admin excluyó el partido, no puntúa.
-- - pasada_at (ms): última pasada del sync tras el final (docs/40 D4).
-- Solo aditiva (columnas nullable, sin backfill): el código anterior no las lee.

ALTER TABLE prode_matches ADD COLUMN auto_home_goals_90 INTEGER;
ALTER TABLE prode_matches ADD COLUMN auto_away_goals_90 INTEGER;
ALTER TABLE prode_matches ADD COLUMN auto_pasa TEXT;
ALTER TABLE prode_matches ADD COLUMN auto_regla TEXT;
ALTER TABLE prode_matches ADD COLUMN auto_visto_at INTEGER;
ALTER TABLE prode_matches ADD COLUMN auto_confirmado_at INTEGER;
ALTER TABLE prode_matches ADD COLUMN excluded_at INTEGER;
ALTER TABLE prode_matches ADD COLUMN pasada_at INTEGER;
