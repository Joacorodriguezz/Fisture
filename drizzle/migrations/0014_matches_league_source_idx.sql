-- Migration: 0014_matches_league_source_idx
-- Description: índice de matches por competencia y fuente (docs/30 D2). El sync busca los partidos
-- existentes de cada competencia con league_id = ? AND source = ?, y el chequeo empty_league hace un
-- NOT EXISTS por league_id. Sin índice, las dos consultas recorrían matches entera en cada llamada.
-- Solo aditiva: el código anterior no lo necesita y no se ve afectado.

CREATE INDEX IF NOT EXISTS idx_matches_league_source ON matches (league_id, source);
