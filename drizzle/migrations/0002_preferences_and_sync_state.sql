-- Migration: 0002_preferences_and_sync_state
-- Description: preferencias de usuario (avisos y tema) y fecha del partido
-- sincronizada, para detectar eventos desactualizados (needs_update).

-- ============================================
-- CALENDAR SYNCS: fecha del partido al momento de sincronizar
-- ============================================

ALTER TABLE calendar_syncs ADD COLUMN synced_date_time INTEGER;

-- ============================================
-- USER PREFERENCES
-- ============================================

CREATE TABLE user_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reminder_60 INTEGER NOT NULL DEFAULT 1,
  reminder_15 INTEGER NOT NULL DEFAULT 1,
  theme TEXT NOT NULL DEFAULT 'papel'
);
