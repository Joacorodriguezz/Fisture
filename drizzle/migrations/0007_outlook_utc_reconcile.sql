-- Migration: 0007_outlook_utc_reconcile
-- Description: los eventos de Outlook creados antes del cambio de zona horaria a UTC quedaron 3 h corridos.
-- Se marcan needs_update para que el cron (reconcileCalendars) los reescriba con la hora correcta.
-- Solo eventos vivos (synced con evento); los partidos ya jugados los descarta el cron por su cuenta.

UPDATE calendar_syncs SET status = 'needs_update'
WHERE provider = 'microsoft' AND status = 'synced' AND external_event_id IS NOT NULL;
