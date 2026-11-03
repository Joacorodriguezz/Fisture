-- Migration: 0009_leagues_is_featured
-- Description: competencias destacadas (docs/22). Solo las destacadas se listan en /ligas, en los
-- filtros y en la búsqueda; las demás copas (nacionales, supercopas, Recopa...) solo aparecen en el
-- fixture de cada equipo. Solo aditiva: el código anterior ignora la columna.

ALTER TABLE leagues ADD COLUMN is_featured INTEGER NOT NULL DEFAULT 1;

-- Copas que ya estaban cargadas y dejan de listarse (el sync también lo corrige en cada pasada)
UPDATE leagues SET is_featured = 0 WHERE external_id IN ('conmebol.recopa', 'uefa.super_cup');
