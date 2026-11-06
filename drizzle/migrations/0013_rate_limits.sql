-- Migration: 0013_rate_limits
-- Description: contadores del límite de tasa de la API (docs/16). Ventana fija: una fila por
-- (bucket, subject, window_start). subject es el id de usuario o un hash (HMAC) de la IP, nunca la IP.
-- Solo aditiva: el código anterior ignora la tabla. Se escribe a mano porque Drizzle no expresa WITHOUT ROWID
-- (sin índice secundario: cada hit escribe una sola fila). La limpieza (>24 h) corre en el sync diario.
-- Las migraciones 0011 y 0012 están reservadas a otros PRs en curso.

CREATE TABLE rate_limits (
  bucket TEXT NOT NULL,
  subject TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, subject, window_start)
) WITHOUT ROWID;
