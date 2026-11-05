-- Migration: 0011_sync_kind_y_calendario_por_usuario
-- Description: sync confiable (docs/17). sync_runs.kind separa los runs de ligas de los de
-- calendarios (los runs existentes son de ligas). users.calendar_reconciled_at ordena la rotación del
-- sync de calendarios (el menos atendido primero) y users.calendar_auth_status marca a quien perdió
-- el acceso a su calendario. Solo aditiva: el código anterior ignora las columnas nuevas.
-- Las sentencias salen de `npm run db:generate`; el snapshot de drizzle-kit quedó en la 0000, así que
-- se recortaron a mano a lo nuevo, como las migraciones 0001 a 0009.

ALTER TABLE `sync_runs` ADD `kind` text DEFAULT 'leagues' NOT NULL;
CREATE INDEX `idx_sync_runs_kind_started` ON `sync_runs` (`kind`,`started_at`);
ALTER TABLE `users` ADD `calendar_reconciled_at` integer;
ALTER TABLE `users` ADD `calendar_auth_status` text DEFAULT 'ok' NOT NULL;
CREATE INDEX `idx_users_calendar_reconciled` ON `users` (`calendar_reconciled_at`);
