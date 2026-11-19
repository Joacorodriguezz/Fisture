-- Migration: 0019_prode_pronosticos
-- Description: pronósticos del prode de playoffs. Un pronóstico por usuario y partido (PK compuesta):
-- guardar de nuevo actualiza el mismo (UPSERT). El cierre no se guarda: sale de matches.date_time
-- (src/lib/prode/horario.ts). Borrar la cuenta borra sus pronósticos (cascade).
-- Solo aditiva: el código anterior no lee esta tabla.

CREATE TABLE IF NOT EXISTS prode_predictions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  home_goals INTEGER NOT NULL,
  away_goals INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, match_id)
);
CREATE INDEX IF NOT EXISTS idx_prode_predictions_match ON prode_predictions (match_id);
