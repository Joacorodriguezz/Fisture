-- Migration: 0010_oauth_identities
-- Description: identidades OAuth por (provider, provider_id) y email verificado (docs/18).
-- Solo aditiva: el código anterior ignora la tabla y la columna nueva; users.* conserva los tokens (D6).
-- Aborta de forma explícita si dos usuarios tienen el mismo email salvo mayúsculas (el UPDATE o el
-- índice único fallan): hay que resolverlo a mano antes de migrar.

UPDATE users SET email = lower(trim(email));

CREATE UNIQUE INDEX users_email_lower_idx ON users(lower(email));

ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;

-- El email de Google lo verificó Google; el de Microsoft no se puede garantizar (D2)
UPDATE users SET email_verified = 1 WHERE provider = 'google';

CREATE TABLE oauth_identities (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  tenant_id TEXT,
  email TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  last_login_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE UNIQUE INDEX oauth_identities_provider_id_idx ON oauth_identities(provider, provider_id);
CREATE UNIQUE INDEX oauth_identities_user_provider_idx ON oauth_identities(user_id, provider);
CREATE INDEX oauth_identities_user_id_idx ON oauth_identities(user_id);

-- Identidad principal de cada usuario: id = users.id, tokens copiados tal cual (una sola sentencia)
INSERT INTO oauth_identities (id, user_id, provider, provider_id, email, email_verified, access_token, refresh_token, token_expires_at, created_at, last_login_at)
SELECT id, id, provider, provider_id, email, email_verified, access_token, refresh_token, token_expires_at, created_at, created_at
FROM users;
