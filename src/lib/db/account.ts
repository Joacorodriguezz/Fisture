import type { D1Database } from "@cloudflare/workers-types";

export interface FilasBorradas {
  users: number;
  userTeams: number;
  userPreferences: number;
  calendarSyncs: number;
  prodeGroupMembers: number;
  // Grupos del prode del usuario: los que pasan a otro integrante y los que se borran por quedar vacíos
  prodeGroupsTransferidos: number;
  prodeGroups: number;
}

// Integrante más antiguo del grupo (sin contar al usuario que se va); empate por user_id para ser determinístico
const SUCESOR = `SELECT m.user_id FROM prode_group_members AS m
  WHERE m.group_id = prode_groups.id AND m.user_id != ?1
  ORDER BY m.joined_at, m.user_id LIMIT 1`;
const CON_OTROS = `EXISTS (SELECT 1 FROM prode_group_members AS m WHERE m.group_id = prode_groups.id AND m.user_id != ?1)`;

// Borra al usuario; las FK con ON DELETE CASCADE se llevan user_teams, user_preferences,
// calendar_syncs, sessions y prode_group_members. prode_groups.owner_id es RESTRICT: antes del
// DELETE, cada grupo del que es dueño pasa al integrante más antiguo, o se borra si no queda nadie.
// El batch de D1 es una transacción: los conteos (para el log) y los cambios ven el mismo estado y,
// si algo falla, no se borra nada.
export async function deleteAccount(DB: D1Database, userId: string): Promise<FilasBorradas> {
  const contar = (tabla: string) => DB.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE user_id = ?1`).bind(userId);
  const contarGrupos = (condicion: string) =>
    DB.prepare(`SELECT COUNT(*) AS n FROM prode_groups WHERE owner_id = ?1 AND ${condicion}`).bind(userId);
  // `meta.changes` de D1 incluye las filas borradas en cascada (sessions), por eso users se cuenta aparte
  const [usuarios, equipos, prefs, syncs, membresias, transferidos, vacios] = await DB.batch<{ n: number }>([
    DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?1").bind(userId),
    contar("user_teams"),
    contar("user_preferences"),
    contar("calendar_syncs"),
    contar("prode_group_members"),
    contarGrupos(CON_OTROS),
    contarGrupos(`NOT ${CON_OTROS}`),
    DB.prepare(`UPDATE prode_groups SET owner_id = (${SUCESOR}) WHERE owner_id = ?1 AND ${CON_OTROS}`).bind(userId),
    DB.prepare("DELETE FROM prode_groups WHERE owner_id = ?1").bind(userId),
    DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId),
  ]);
  return {
    users: usuarios.results[0]?.n ?? 0,
    userTeams: equipos.results[0]?.n ?? 0,
    userPreferences: prefs.results[0]?.n ?? 0,
    calendarSyncs: syncs.results[0]?.n ?? 0,
    prodeGroupMembers: membresias.results[0]?.n ?? 0,
    prodeGroupsTransferidos: transferidos.results[0]?.n ?? 0,
    prodeGroups: vacios.results[0]?.n ?? 0,
  };
}
