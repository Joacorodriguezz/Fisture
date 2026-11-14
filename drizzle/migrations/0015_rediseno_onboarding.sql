-- Migration: 0015_rediseno_onboarding
-- Description: datos del rediseño (docs/31 §4). onboarded_at marca que el usuario ya pasó por
-- /bienvenida: los existentes quedan en su fecha de alta para no ver el onboarding. auto_sync_default
-- es el valor inicial de user_teams.auto_sync al seguir un equipo. previous_date_time y
-- date_time_changed_at guardan la hora anterior del partido cuando el sync movió el evento
-- («Horario actualizado», 7 días).
-- Solo aditiva: el código anterior no lee estas columnas y sigue funcionando con la base migrada.

ALTER TABLE users ADD COLUMN onboarded_at INTEGER;
UPDATE users SET onboarded_at = created_at;
ALTER TABLE user_preferences ADD COLUMN auto_sync_default INTEGER NOT NULL DEFAULT 1;
ALTER TABLE calendar_syncs ADD COLUMN previous_date_time INTEGER;
ALTER TABLE calendar_syncs ADD COLUMN date_time_changed_at INTEGER;
