-- Migration: 0022_prode_quien_pasa
-- Description: regla "quién pasa" del prode (docs/40 R2 y R3).
-- - prode_predictions.pasa: equipo que el participante pronostica que pasa ('home' | 'away'). Solo se
--   guarda con un empate pronosticado; con ganador se deriva del marcador y queda NULL.
-- - prode_matches.pasa: equipo que pasó, cargado por el admin ('home' | 'away'). Solo vale si el
--   marcador a 90' es empate; con ganador se deriva del marcador.
-- Solo aditiva (columnas nullable, sin backfill): el código anterior no las lee. Un empate guardado
-- antes de esta migración no tiene pasa y no suma el extra.

ALTER TABLE prode_predictions ADD COLUMN pasa TEXT;
ALTER TABLE prode_matches ADD COLUMN pasa TEXT;
