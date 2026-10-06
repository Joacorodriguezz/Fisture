-- Migration: 0000_init
-- Created at: 2024-01-01
-- Description: Initial schema for FISTURE

-- ============================================
-- USUARIOS Y AUTH
-- ============================================

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  image TEXT,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

-- ============================================
-- LIGAS
-- ============================================

CREATE TABLE IF NOT EXISTS leagues (
  id TEXT PRIMARY KEY,
  api_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  logo TEXT,
  season INTEGER NOT NULL,
  is_active INTEGER DEFAULT 1
);

-- ============================================
-- EQUIPOS
-- ============================================

CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  api_id INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  short_name TEXT,
  logo TEXT,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  country TEXT
);

CREATE INDEX IF NOT EXISTS idx_teams_name ON teams(name);

-- ============================================
-- RELACIÓN USUARIO - EQUIPO
-- ============================================

CREATE TABLE IF NOT EXISTS user_teams (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  auto_sync INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_user_teams_user ON user_teams(user_id);
CREATE INDEX IF NOT EXISTS idx_user_teams_team ON user_teams(team_id);

-- ============================================
-- PARTIDOS
-- ============================================

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  api_id INTEGER NOT NULL UNIQUE,
  home_team_id TEXT NOT NULL REFERENCES teams(id),
  away_team_id TEXT NOT NULL REFERENCES teams(id),
  league_id TEXT NOT NULL REFERENCES leagues(id),
  date_time INTEGER NOT NULL,
  venue TEXT,
  status TEXT DEFAULT 'scheduled',
  home_score INTEGER,
  away_score INTEGER,
  round TEXT,
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date_time);
CREATE INDEX IF NOT EXISTS idx_matches_home_team ON matches(home_team_id);
CREATE INDEX IF NOT EXISTS idx_matches_away_team ON matches(away_team_id);

-- ============================================
-- SINCRONIZACIÓN DE CALENDARIO
-- ============================================

CREATE TABLE IF NOT EXISTS calendar_syncs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_event_id TEXT,
  status TEXT DEFAULT 'pending',
  last_synced_at INTEGER,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_calendar_syncs_status ON calendar_syncs(status);

-- ============================================
-- SEED: LIGAS INICIALES
-- ============================================

INSERT OR IGNORE INTO leagues (id, api_id, name, country, season, is_active) VALUES
  (lower(hex(randomblob(16))), 128, 'Liga Profesional Argentina', 'Argentina', 2024, 1),
  (lower(hex(randomblob(16))), 39, 'Premier League', 'England', 2024, 1),
  (lower(hex(randomblob(16))), 140, 'La Liga', 'Spain', 2024, 1),
  (lower(hex(randomblob(16))), 135, 'Serie A', 'Italy', 2024, 1),
  (lower(hex(randomblob(16))), 78, 'Bundesliga', 'Germany', 2024, 1),
  (lower(hex(randomblob(16))), 61, 'Ligue 1', 'France', 2024, 1);
