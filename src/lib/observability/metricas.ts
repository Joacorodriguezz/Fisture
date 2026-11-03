// Métricas de producto para /api/admin/status: solo conteos agregados, nunca ids ni emails.
// Responden "¿funciona?": cuánta gente se registra, cuántos llegan a agregar un partido y cuántos eventos
// mantiene la app. Las bajas no quedan en la base (el borrado es total): se cuentan desde el log
// `account_deleted` (wrangler pages deployment tail o el dashboard de Workers Logs).
import { sql } from "drizzle-orm";
import type { Database } from "../db";

const DIA_S = 24 * 60 * 60;

export interface Metricas {
  usuarios: number;
  registrosUltimos7Dias: number;
  registrosUltimos30Dias: number;
  // Siguen al menos un equipo
  usuariosConEquipos: number;
  // Tienen al menos un partido en su calendario (calendar_syncs en synced)
  usuariosConPartidos: number;
  eventosEnCalendarios: number;
  equiposSeguidos: number;
  // Usuarios cuyo calendario perdió acceso y esperan volver a iniciar sesión (docs/17 B4)
  calendariosSinAcceso: number;
}

export async function getMetricas(db: Database, ahora = Date.now()): Promise<Metricas> {
  // users.created_at está en segundos
  const hoy = Math.floor(ahora / 1000);
  const [fila] = await db.all<Record<keyof Metricas, number>>(sql`
    SELECT
      (SELECT COUNT(*) FROM users) AS usuarios,
      (SELECT COUNT(*) FROM users WHERE created_at >= ${hoy - 7 * DIA_S}) AS registrosUltimos7Dias,
      (SELECT COUNT(*) FROM users WHERE created_at >= ${hoy - 30 * DIA_S}) AS registrosUltimos30Dias,
      (SELECT COUNT(DISTINCT user_id) FROM user_teams) AS usuariosConEquipos,
      (SELECT COUNT(DISTINCT user_id) FROM calendar_syncs WHERE status = 'synced') AS usuariosConPartidos,
      (SELECT COUNT(*) FROM calendar_syncs WHERE status = 'synced') AS eventosEnCalendarios,
      (SELECT COUNT(*) FROM user_teams) AS equiposSeguidos,
      (SELECT COUNT(*) FROM users WHERE calendar_auth_status = 'reauth_required') AS calendariosSinAcceso
  `);
  return {
    usuarios: Number(fila.usuarios),
    registrosUltimos7Dias: Number(fila.registrosUltimos7Dias),
    registrosUltimos30Dias: Number(fila.registrosUltimos30Dias),
    usuariosConEquipos: Number(fila.usuariosConEquipos),
    usuariosConPartidos: Number(fila.usuariosConPartidos),
    eventosEnCalendarios: Number(fila.eventosEnCalendarios),
    equiposSeguidos: Number(fila.equiposSeguidos),
    calendariosSinAcceso: Number(fila.calendariosSinAcceso),
  };
}
