import type { D1Database } from "@cloudflare/workers-types";

export interface FilasBorradas {
  users: number;
  userTeams: number;
  userPreferences: number;
  calendarSyncs: number;
}

// Borra al usuario; las FK con ON DELETE CASCADE se llevan user_teams, user_preferences y
// calendar_syncs. El batch de D1 es una transacción: los conteos (para el log) y el DELETE
// ven el mismo estado y, si algo falla, no se borra nada.
export async function deleteAccount(DB: D1Database, userId: string): Promise<FilasBorradas> {
  const contar = (tabla: string) => DB.prepare(`SELECT COUNT(*) AS n FROM ${tabla} WHERE user_id = ?1`).bind(userId);
  // `meta.changes` de D1 incluye las filas borradas en cascada (sessions), por eso users se cuenta aparte
  const [usuarios, equipos, prefs, syncs] = await DB.batch<{ n: number }>([
    DB.prepare("SELECT COUNT(*) AS n FROM users WHERE id = ?1").bind(userId),
    contar("user_teams"),
    contar("user_preferences"),
    contar("calendar_syncs"),
    DB.prepare("DELETE FROM users WHERE id = ?1").bind(userId),
  ]);
  return {
    users: usuarios.results[0]?.n ?? 0,
    userTeams: equipos.results[0]?.n ?? 0,
    userPreferences: prefs.results[0]?.n ?? 0,
    calendarSyncs: syncs.results[0]?.n ?? 0,
  };
}
