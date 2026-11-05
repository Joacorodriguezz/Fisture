// Reconciliación de calendarios por lotes (docs/17 D4). Corrige los eventos desactualizados de todos
// los usuarios y da de alta los partidos pendientes de los equipos con auto-sync (docs/11 D12).
//
// Workers Free permite 50 subrequests por invocación (cada consulta D1 y cada fetch), así que un solo
// request no alcanza a todos. El workflow llama varias veces (POST /api/admin/sync con
// {"calendarios": true}); cada lote atiende a los usuarios menos atendidos primero y se detiene al
// agotar el presupuesto (calendar/presupuesto.ts). La rotación sale de users.calendar_reconciled_at:
// quien se atiende pasa al final, así nadie queda relegado y no hace falta un cursor aparte.
import { and, asc, eq, gte, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { calendarSyncs, matches, users } from "../../../drizzle/schema";
import type { Database } from "../db";
import { getAutoSyncMatchIds } from "../db/queries";
import { mensajeDeError, rootLogger } from "../observability/logger";
import type { ResumenCalendarios } from "../observability/sync-runs";
import {
  COSTO_FIJO_USUARIO,
  COSTO_MAX_PARTIDO,
  COSTO_RENOVACION_401,
  COSTO_TOKEN_USUARIO,
  PRESUPUESTO_SUBREQUESTS,
  RESERVA_REGISTRO,
  Presupuesto,
} from "./presupuesto";
import { HORAS_PARTIDO_JUGADO, markOutdatedEvents, syncMatches, type SyncDeps, type SyncResult } from "./sync-service";

// Tope de partidos por turno: un usuario con 80 pendientes no consume el presupuesto de todos. Con el
// presupuesto de 45 (menos 3 de reserva), el costo fijo de un usuario (8), su token (4), la reserva para un
// 401 (6) y el peor caso de un partido (6: 3 consultas y un alta con adopción de 3 llamadas), tres partidos
// entran incluso en el primer lote del barrido, que además gasta 5 en detectar eventos desactualizados y
// elegir candidatos: 5 + 8 + 4 + 6 + 3 x 6 = 41 de 42. Con cuatro serían 47.
export const PARTIDOS_POR_TURNO = 3;
// Usuarios que se traen por lote. El presupuesto corta antes en la práctica (~3 a 5 usuarios).
export const USUARIOS_POR_LOTE = 10;

export interface ReconcileOptions {
  now?: Date;
  // Epoch ms. Solo se atiende a quien no fue atendido desde entonces: así un barrido (varios lotes
  // seguidos) recorre a cada usuario una sola vez. Por defecto, `now`.
  corte?: number;
  presupuesto?: Presupuesto;
  matchesPerUser?: number;
  maxUsers?: number;
  // Detectar eventos desactualizados (4 consultas set-based sobre toda la tabla): solo el primer lote
  marcarDesactualizados?: boolean;
}

type DbUser = typeof users.$inferSelect;

// Partidos que hay que corregir o reintentar de un usuario, los más próximos primero
async function pendingMatchIds(db: Database, userId: string, now: Date, limit: number): Promise<string[]> {
  const limiteJugado = new Date(now.getTime() - HORAS_PARTIDO_JUGADO * 3600 * 1000);
  const rows = await db
    .select({ matchId: calendarSyncs.matchId })
    .from(calendarSyncs)
    .innerJoin(matches, eq(matches.id, calendarSyncs.matchId))
    .where(
      and(
        eq(calendarSyncs.userId, userId),
        inArray(calendarSyncs.status, ["needs_update", "failed"]),
        gte(matches.dateTime, limiteJugado)
      )
    )
    // Primero las correcciones nuevas: un evento que falla siempre (failed) se reintenta a diario y, si fuera
    // por fecha, ocuparía todos los turnos de ese usuario
    .orderBy(sql`${calendarSyncs.status} = 'failed'`, asc(matches.dateTime))
    .limit(limit);
  return rows.map((r) => r.matchId);
}

// Usuarios con trabajo real (eventos por corregir o partidos de equipos con auto-sync sin alta) y con
// el calendario accesible, el menos atendido primero. Los que nunca se atendieron van antes que todos
// y el empate se desempata por id (orden estable).
async function candidatos(db: Database, now: Date, corte: number, limit: number): Promise<DbUser[]> {
  const ahora = Math.floor(now.getTime() / 1000);
  const limiteJugado = ahora - HORAS_PARTIDO_JUGADO * 3600;
  const conTrabajo = sql`(
    EXISTS (
      SELECT 1 FROM calendar_syncs cs JOIN matches m ON m.id = cs.match_id
      WHERE cs.user_id = ${users.id} AND cs.status IN ('needs_update', 'failed') AND m.date_time >= ${limiteJugado}
    )
    OR EXISTS (
      SELECT 1 FROM user_teams ut
      JOIN matches m ON (m.home_team_id = ut.team_id OR m.away_team_id = ut.team_id)
      WHERE ut.user_id = ${users.id} AND ut.auto_sync = 1 AND m.date_time >= ${ahora}
        AND NOT EXISTS (
          SELECT 1 FROM calendar_syncs cs
          WHERE cs.user_id = ${users.id} AND cs.match_id = m.id AND cs.status IN ('synced', 'detached', 'cancelled')
        )
    )
  )`;
  return db
    .select()
    .from(users)
    .where(
      and(
        eq(users.calendarAuthStatus, "ok"),
        or(isNull(users.calendarReconciledAt), lt(users.calendarReconciledAt, corte)),
        conTrabajo
      )
    )
    .orderBy(sql`${users.calendarReconciledAt} IS NOT NULL`, asc(users.calendarReconciledAt), asc(users.id))
    .limit(limit);
}

// Siempre que se atiende a un usuario, haya andado o no, pasa al final de la rotación
function marcarAtendido(db: Database, userId: string, ahoraMs: number, extra: Partial<typeof users.$inferInsert> = {}) {
  return db.update(users).set({ calendarReconciledAt: ahoraMs, ...extra }).where(eq(users.id, userId));
}

// Un lote de la reconciliación. `db` debería ser la D1 instrumentada (contarD1) del mismo `presupuesto`
// para que cada consulta cuente; el lote nunca empieza un usuario ni un partido sin lugar para terminarlo.
export async function reconcileCalendarBatch(
  env: Env,
  db: Database,
  deps?: SyncDeps,
  options: ReconcileOptions = {}
): Promise<ResumenCalendarios> {
  const now = options.now ?? new Date();
  const ahoraMs = now.getTime();
  const corte = options.corte ?? ahoraMs;
  const perUser = options.matchesPerUser ?? PARTIDOS_POR_TURNO;
  const limite = options.maxUsers ?? USUARIOS_POR_LOTE;
  const presupuesto = options.presupuesto ?? new Presupuesto(PRESUPUESTO_SUBREQUESTS, RESERVA_REGISTRO);

  const resumen: ResumenCalendarios = {
    usuarios: 0,
    eventosOk: 0,
    eventosFallidos: 0,
    sinAcceso: 0,
    cortadoPorPresupuesto: false,
    quedan: false,
    subrequests: 0,
  };

  if (options.marcarDesactualizados) await markOutdatedEvents(db, undefined, now);

  const lista = await candidatos(db, now, corte, limite);
  // Un lote lleno puede dejar usuarios atrás; uno que no se llenó los atendió a todos
  resumen.quedan = lista.length >= limite;

  for (const user of lista) {
    // Lugar para el costo fijo, el token y al menos un partido con su posible reintento tras un 401
    if (!presupuesto.alcanza(COSTO_FIJO_USUARIO + COSTO_TOKEN_USUARIO + COSTO_MAX_PARTIDO + COSTO_RENOVACION_401)) {
      resumen.cortadoPorPresupuesto = true;
      resumen.quedan = true;
      break;
    }

    try {
      // Primero las correcciones: valen más que las altas nuevas
      const pendientes = await pendingMatchIds(db, user.id, now, perUser);
      const nuevos = await getAutoSyncMatchIds(db, user.id, perUser);
      const ids = [...new Set([...pendientes, ...nuevos])].slice(0, perUser);

      const results: SyncResult[] = ids.length === 0 ? [] : await syncMatches(db, env, user, ids, { mode: "auto", deps, presupuesto });

      // Sin presupuesto en medio del usuario: lo que se alcanzó a procesar es progreso. Si hubo alguno se lo
      // marca atendido para que rote (el resto sigue en su próximo turno); si no hubo ninguno no se lo marca y
      // el lote lo informa como sin progreso.
      const cortado = results.length < ids.length;
      if (cortado) {
        resumen.cortadoPorPresupuesto = true;
        resumen.quedan = true;
        if (results.length === 0) break;
      }

      resumen.usuarios++;
      resumen.eventosOk += results.filter((r) => r.success).length;
      resumen.eventosFallidos += results.filter((r) => !r.success).length;

      // Solo un error de token prueba que hay que volver a conectar. Un 401 que persiste tras renovar puede
      // ser transitorio del proveedor: la fila queda pendiente, sin marcar, y se reintenta al día siguiente.
      if (results.some((r) => r.tokenInvalido)) {
        // Sin acceso al calendario: sale de la cola hasta que vuelva a iniciar sesión (B4)
        resumen.sinAcceso++;
        await marcarAtendido(db, user.id, ahoraMs, { calendarAuthStatus: "reauth_required" });
        rootLogger.warn("calendar_reauth_required", { provider: user.provider });
      } else {
        await marcarAtendido(db, user.id, ahoraMs);
        rootLogger.info("calendar_reconcile_user", {
          provider: user.provider,
          ok: results.filter((r) => r.success).length,
          total: results.length,
        });
      }
      if (cortado) break;
    } catch (error) {
      // Un usuario que falla no bloquea a los demás ni se reintenta en este barrido
      resumen.usuarios++;
      rootLogger.error("calendar_reconcile_user_failed", { err: error, message: mensajeDeError(error) });
      try {
        await marcarAtendido(db, user.id, ahoraMs);
      } catch {
        // Si ni eso se puede, el run lo refleja por el límite de lotes del barrido
      }
    }
  }

  resumen.subrequests = presupuesto.usado;
  return resumen;
}
