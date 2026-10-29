-- Migration: 0008_sessions
-- Description: sesiones en D1 en lugar de KV (docs/21). id = SHA-256 hex del token de la cookie.
-- Solo aditiva: el código anterior ignora la tabla. No migra sesiones existentes (D7).

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX sessions_user_id_idx ON sessions(user_id);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);
