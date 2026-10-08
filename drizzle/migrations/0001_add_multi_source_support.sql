-- Migration: 0001_add_multi_source_support
-- Created at: 2024-01-02
-- Description: Add support for multiple data sources (football-data.org, promiedos)

-- SQLite doesn't support ALTER COLUMN, so we need to recreate tables
-- This will drop existing data - only run in development!

-- ============================================
-- DROP EXISTING TABLES (dev only!)
-- ============================================

DROP TABLE IF EXISTS calendar_syncs;
DROP TABLE IF EXISTS matches;
DROP TABLE IF EXISTS user_teams;
DROP TABLE IF EXISTS teams;
DROP TABLE IF EXISTS leagues;
DROP TABLE IF EXISTS users;

-- ============================================
-- USERS (unchanged)
-- ============================================

CREATE TABLE users (
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
-- LEAGUES (updated: external_id + source)
-- ============================================

CREATE TABLE leagues (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  country TEXT NOT NULL,
  logo TEXT,
  season INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'football-data',
  is_active INTEGER DEFAULT 1
);

-- ============================================
-- TEAMS (updated: external_id + source + updated_at)
-- ============================================

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  short_name TEXT,
  logo TEXT,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  country TEXT,
  source TEXT NOT NULL DEFAULT 'football-data',
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX idx_teams_name ON teams(name);

-- ============================================
-- USER_TEAMS (unchanged)
-- ============================================

CREATE TABLE user_teams (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  auto_sync INTEGER DEFAULT 1,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX idx_user_teams_user ON user_teams(user_id);
CREATE INDEX idx_user_teams_team ON user_teams(team_id);

-- ============================================
-- MATCHES (updated: external_id + source)
-- ============================================

CREATE TABLE matches (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  home_team_id TEXT NOT NULL REFERENCES teams(id),
  away_team_id TEXT NOT NULL REFERENCES teams(id),
  league_id TEXT NOT NULL REFERENCES leagues(id),
  date_time INTEGER NOT NULL,
  venue TEXT,
  status TEXT DEFAULT 'scheduled',
  home_score INTEGER,
  away_score INTEGER,
  round TEXT,
  source TEXT NOT NULL DEFAULT 'football-data',
  updated_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX idx_matches_date ON matches(date_time);
CREATE INDEX idx_matches_home_team ON matches(home_team_id);
CREATE INDEX idx_matches_away_team ON matches(away_team_id);

-- ============================================
-- CALENDAR_SYNCS (unchanged)
-- ============================================

CREATE TABLE calendar_syncs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  external_event_id TEXT,
  status TEXT DEFAULT 'pending',
  last_synced_at INTEGER,
  error_message TEXT
);

CREATE INDEX idx_calendar_syncs_status ON calendar_syncs(status);
