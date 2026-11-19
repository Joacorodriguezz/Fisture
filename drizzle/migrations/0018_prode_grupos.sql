-- Migration: 0018_prode_grupos
-- Description: grupos privados del prode de playoffs. Un grupo se crea con un nombre y un código de
-- invitación aleatorio y único; solo los integrantes (prode_group_members) pueden verlo.
-- Solo aditiva: tablas nuevas que el código anterior no lee.
-- owner_id es RESTRICT, no CASCADE: si el dueño borra su cuenta el grupo no debe desaparecer con
-- sus integrantes. deleteAccount (src/lib/db/account.ts) pasa antes la propiedad al integrante más
-- antiguo o borra el grupo si el dueño era el único; un DELETE de users que lo saltee falla.

CREATE TABLE IF NOT EXISTS prode_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS prode_groups_invite_code_unique ON prode_groups (invite_code);

CREATE TABLE IF NOT EXISTS prode_group_members (
  group_id TEXT NOT NULL REFERENCES prode_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS prode_group_members_user_idx ON prode_group_members (user_id);
