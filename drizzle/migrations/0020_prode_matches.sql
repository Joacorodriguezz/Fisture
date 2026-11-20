-- Migration: 0020_prode_matches
-- Description: vínculo de los partidos del prode. Un partido es "del prode" si tiene fila acá, venga
-- de donde venga: un cruce cargado a mano (source = 'manual') o uno de ESPN adoptado por el admin. La
-- fase vive en el vínculo (matches.round de ESPN es del proveedor). Si el sync de ESPN trae un cruce
-- que ya estaba cargado a mano, el vínculo y los pronósticos pasan al partido de ESPN (docs/37).
-- Borrar el partido borra el vínculo (cascade).
-- Solo aditiva: el código anterior no lee esta tabla. Backfill: los cruces manuales existentes, con
-- la fase que guardaban en round.

CREATE TABLE IF NOT EXISTS prode_matches (
  match_id TEXT PRIMARY KEY NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  fase TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO prode_matches (match_id, fase, created_at)
SELECT id, round, CAST(strftime('%s', 'now') AS INTEGER) * 1000
FROM matches
WHERE source = 'manual' AND round IN ('octavos', 'cuartos', 'semifinal', 'final');
