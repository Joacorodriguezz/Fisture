-- Migration: 0016_slugs_equipos_ligas
-- Description: nombre en la URL pública de equipos y ligas (docs/33 D9): /equipos/atletico-tucuman en
-- lugar del UUID. La columna es nullable y el índice único admite varios NULL: las filas existentes
-- quedan sin slug y siguen respondiendo por id hasta el backfill (POST /api/admin/slugs, docs/23 §6).
-- No hay backfill acá: SQLite no puede quitar tildes ni normalizar el nombre.
-- Solo aditiva: el código anterior no lee estas columnas y sigue funcionando con la base migrada.

ALTER TABLE teams ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS teams_slug_idx ON teams (slug);
ALTER TABLE leagues ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS leagues_slug_idx ON leagues (slug);
