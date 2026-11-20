-- Migration: 0017_prode
-- Description: tablas del prode (docs/37 §4). Un grupo es una competencia con nombre y código de
-- invitación; sus miembros pronostican los partidos y el sync puntúa (lib/prode/puntuar.ts).
-- Un pronóstico es por usuario y partido y vale en todos los grupos del usuario (docs/37 D1).
-- owner_id queda en NULL si el dueño borra su cuenta: administra el miembro más antiguo (D8).
-- Fechas en segundos Unix, como matches.date_time.
-- Solo aditiva: el código anterior no lee estas tablas y sigue funcionando con la base migrada.

CREATE TABLE IF NOT EXISTS prode_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  invite_code TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  starts_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS prode_groups_invite_code_idx ON prode_groups (invite_code);

CREATE TABLE IF NOT EXISTS prode_members (
  group_id TEXT NOT NULL REFERENCES prode_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS prode_members_user_idx ON prode_members (user_id);

CREATE TABLE IF NOT EXISTS prode_predictions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  home_goals INTEGER NOT NULL,
  away_goals INTEGER NOT NULL,
  points INTEGER,
  scored_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, match_id)
);
CREATE INDEX IF NOT EXISTS prode_predictions_match_idx ON prode_predictions (match_id);
