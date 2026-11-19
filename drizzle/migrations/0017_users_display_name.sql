-- Migration: 0017_users_display_name
-- Description: nombre visible del prode de playoffs (tarjeta "Permitir el ingreso y elegir nombre
-- visible"). Es lo único que se muestra de un participante en posiciones y grupos, nunca el email.
-- Nullable: NULL = todavía no lo eligió. Sin unicidad (dos personas pueden llamarse igual).
-- Solo aditiva: el código anterior no lee esta columna y sigue funcionando con la base migrada.

ALTER TABLE users ADD COLUMN display_name TEXT;
