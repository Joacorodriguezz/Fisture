-- Migration: 0006_calendar_syncs_idempotencia
-- Description: unicidad (user_id, match_id), columnas de estado sincronizado y estados detached/cancelled.

-- 1. Quitar duplicados: por (user_id, match_id) se conserva la fila synced con evento y la más reciente
DELETE FROM calendar_syncs WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY user_id, match_id
      ORDER BY (status = 'synced') DESC, (external_event_id IS NOT NULL) DESC, last_synced_at DESC
    ) AS rn FROM calendar_syncs
  ) WHERE rn > 1
);

-- 2. Unicidad (reemplaza el índice no único de la migración 0005)
DROP INDEX IF EXISTS idx_calendar_syncs_user_match;
CREATE UNIQUE INDEX uq_calendar_syncs_user_match ON calendar_syncs(user_id, match_id);

-- 3. Lo que tenía el evento cuando se sincronizó
ALTER TABLE calendar_syncs ADD COLUMN synced_state TEXT;
ALTER TABLE calendar_syncs ADD COLUMN synced_venue TEXT;

-- 4. Backfill: asumimos que los eventos sincronizados reflejan el partido actual (igual que 0005 con la fecha)
UPDATE calendar_syncs SET
  synced_state = 'scheduled',
  synced_venue = (SELECT NULLIF(venue, '') FROM matches WHERE matches.id = calendar_syncs.match_id)
WHERE status = 'synced';
