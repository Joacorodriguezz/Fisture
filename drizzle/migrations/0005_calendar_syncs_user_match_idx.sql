-- Migration: 0005_calendar_syncs_user_match_idx
-- Description: índice para las consultas por (usuario, partido) de getSyncStates y markOutdatedEvents.

CREATE INDEX idx_calendar_syncs_user_match ON calendar_syncs(user_id, match_id);
