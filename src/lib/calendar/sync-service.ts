// Sincronización de partidos con el calendario del usuario (Google / Microsoft).
// La usan la API (/api/calendario/*) y el cron diario (functions/scheduled.ts).
// Diseño y decisiones: docs/11-calendario-casos-borde-tdd.md

import { and, asc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { calendarSyncs, matches, users, userTeams } from "../../../drizzle/schema";
import { getValidAccessToken } from "../auth/tokens";
import type { Database } from "../db";
import { rootLogger } from "../observability/logger";
import { getMatchDetail, getAutoSyncMatchIds } from "../db/queries";
import { getPreferences } from "../db/preferences";
import { getClient, type CalendarClient, type MatchDetail } from "./clients";
import { classifyCalendarError, type CalendarErrorClass } from "./errors";
import { eventState, type OverlapItem } from "./event-state";

type DbUser = typeof users.$inferSelect;

export interface SyncWarning {
  code: "overlap";
  count: number;
  items: OverlapItem[];
}

export interface SyncResult {
  matchId: string;
  success: boolean;
  error?: string;
  // Por qué falló (solo auth y rate_limit cortan el resto de la tanda)
  code?: CalendarErrorClass;
  warnings?: SyncWarning[];
}

// "manual": el usuario lo pidió (clic). "auto": lo corre el cron y no debe resucitar lo que el usuario quitó.
export type SyncMode = "manual" | "auto";

// Dependencias inyectables (los tests reemplazan el proveedor real y el token)
export interface SyncDeps {
  client?: CalendarClient;
  getToken?: (env: Env, db: Database, user: DbUser) => Promise<string>;
}

export interface SyncOptions {
  mode?: SyncMode;
  deps?: SyncDeps;
}

// Límites del cron: cada partido es una llamada a la API de calendario.
// Cloudflare Workers limita las subrequests por invocación.
const CRON_MAX_USERS = 20;
const CRON_MATCHES_PER_USER = 10;

const MENSAJES_CORTE: Partial<Record<CalendarErrorClass, string>> = {
  auth: "Hay que volver a conectar el calendario",
  rate_limit: "El calendario pidió esperar un rato, reintentá más tarde",
};

type SyncedValues = Partial<typeof calendarSyncs.$inferInsert>;
type SyncRow = typeof calendarSyncs.$inferSelect;

// Inserta o actualiza la fila (user_id, match_id). El índice único evita filas duplicadas si dos
// requests llegan a la vez (D2).
async function saveState(db: Database, userId: string, provider: string, matchId: string, values: SyncedValues) {
  await db
    .insert(calendarSyncs)
    .values({ userId, provider, matchId, ...values })
    .onConflictDoUpdate({ target: [calendarSyncs.userId, calendarSyncs.matchId], set: values });
}

// Lo que debería reflejar el evento hoy; se compara contra lo que tenía al sincronizarse
function snapshot(match: MatchDetail) {
  return {
    dateTime: match.match.dateTime,
    state: eventState(match.match.status),
    venue: match.match.venue || null,
  };
}
type Snapshot = ReturnType<typeof snapshot>;

function syncedValues(snap: Snapshot): SyncedValues {
  return { syncedDateTime: snap.dateTime, syncedState: snap.state, syncedVenue: snap.venue };
}

function upToDate(existing: SyncRow | undefined, snap: Snapshot): boolean {
  return (
    existing?.status === "synced" &&
    existing.syncedDateTime?.getTime() === snap.dateTime.getTime() &&
    (existing.syncedState ?? "scheduled") === snap.state &&
    (existing.syncedVenue ?? null) === snap.venue
  );
}

// Crea o actualiza el evento de cada partido en el calendario del usuario
export async function syncMatches(
  db: Database,
  env: Env,
  user: DbUser,
  matchIds: string[],
  options: SyncOptions = {}
): Promise<SyncResult[]> {
  const mode = options.mode ?? "manual";
  const ids = [...new Set(matchIds)];
  const prefs = await getPreferences(db, user.id);
  const client = options.deps?.client ?? getClient(user.provider);
  const getToken = options.deps?.getToken ?? getValidAccessToken;
  const results: SyncResult[] = [];

  for (let i = 0; i < ids.length; i++) {
    const matchId = ids[i];
    try {
      const match = await getMatchDetail(db, matchId);
      if (!match) {
        results.push({ matchId, success: false, error: "Partido no encontrado" });
        continue;
      }

      const existing = await db.query.calendarSyncs.findFirst({
        where: and(eq(calendarSyncs.userId, user.id), eq(calendarSyncs.matchId, matchId)),
      });
      const snap = snapshot(match);

      if (upToDate(existing, snap)) {
        results.push({ matchId, success: true });
        continue;
      }
      // Lo que el usuario quitó a mano no se resucita en forma automática (D5)
      if (existing?.status === "detached" && mode === "auto") {
        results.push({ matchId, success: true });
        continue;
      }

      if (snap.state === "cancelled") {
        results.push(await cancelEvent(db, env, user, matchId, existing, snap, client, getToken));
        continue;
      }

      const token = await getToken(env, db, user);

      let externalEventId: string;
      if (existing?.externalEventId) {
        try {
          // El evento existe (cambió el partido): se actualiza en lugar de duplicarlo
          await client.update(token, existing.externalEventId, match, prefs);
          externalEventId = existing.externalEventId;
        } catch (error) {
          // Solo "el evento ya no existe" justifica otro camino. Cualquier otro error se propaga:
          // crear un evento nuevo ante un 5xx o un 429 lo duplicaría (G1).
          if (classifyCalendarError(error) !== "gone") throw error;

          if (mode === "auto") {
            await saveState(db, user.id, user.provider, matchId, {
              status: "detached",
              externalEventId: null,
              errorMessage: null,
            });
            results.push({ matchId, success: true });
            continue;
          }
          externalEventId = await client.create(token, match, prefs, { userId: user.id });
        }
      } else {
        externalEventId = await client.create(token, match, prefs, { userId: user.id });
      }

      await saveState(db, user.id, user.provider, matchId, {
        externalEventId,
        status: "synced",
        lastSyncedAt: new Date(),
        errorMessage: null,
        ...syncedValues(snap),
      });

      const result: SyncResult = { matchId, success: true };
      // Solo cuando el usuario agrega un partido a mano: en lotes y en el cron cuesta una llamada por partido (D7)
      if (mode === "manual" && ids.length === 1) {
        const warnings = await overlapWarnings(client, token, match, externalEventId);
        if (warnings) result.warnings = warnings;
      }
      results.push(result);
    } catch (error) {
      const code = classifyCalendarError(error);

      if (code === "auth" || code === "rate_limit") {
        // No es culpa del partido: se corta, no se marca nada como failed y se reintenta cuando se pueda (D4)
        rootLogger.warn("calendar_sync_aborted", { matchId, code, pending: ids.length - i });
        const message = MENSAJES_CORTE[code] ?? "Error desconocido";
        for (const id of ids.slice(i)) results.push({ matchId: id, success: false, error: message, code });
        break;
      }

      const message = error instanceof Error ? error.message : "Error desconocido";
      rootLogger.error("calendar_match_sync_failed", { matchId, code, message });

      await saveState(db, user.id, user.provider, matchId, {
        status: "failed",
        errorMessage: message,
      });

      results.push({ matchId, success: false, error: message, code });
    }
  }

  return results;
}

// Partido cancelado: se quita el evento y la fila queda cancelled (D10)
async function cancelEvent(
  db: Database,
  env: Env,
  user: DbUser,
  matchId: string,
  existing: SyncRow | undefined,
  snap: Snapshot,
  client: CalendarClient,
  getToken: NonNullable<SyncDeps["getToken"]>
): Promise<SyncResult> {
  if (existing?.status === "cancelled") return { matchId, success: true };
  if (!existing) return { matchId, success: false, error: "El partido está cancelado" };

  if (existing.externalEventId) {
    const token = await getToken(env, db, user);
    try {
      await client.remove(token, existing.externalEventId);
    } catch (error) {
      if (classifyCalendarError(error) !== "gone") throw error;
    }
  }

  await saveState(db, user.id, user.provider, matchId, {
    status: "cancelled",
    externalEventId: null,
    lastSyncedAt: new Date(),
    errorMessage: null,
    ...syncedValues(snap),
  });
  return { matchId, success: true };
}

// Aviso de eventos ajenos superpuestos. Un fallo acá nunca debe estropear el alta del partido.
async function overlapWarnings(
  client: CalendarClient,
  token: string,
  match: MatchDetail,
  eventId: string
): Promise<SyncWarning[] | undefined> {
  try {
    const items = await client.overlaps(token, match, eventId);
    if (items.length === 0) return undefined;
    // Los títulos son del usuario: se devuelven a él y no se loguean
    return [{ code: "overlap", count: items.length, items }];
  } catch (error) {
    rootLogger.warn("calendar_overlap_check_failed", { code: classifyCalendarError(error) });
    return undefined;
  }
}

// Borra el evento del calendario y deja de tratar el partido como sincronizado
export async function removeMatchFromCalendar(
  db: Database,
  env: Env,
  user: DbUser,
  matchId: string,
  deps: SyncDeps = {}
): Promise<void> {
  const existing = await db.query.calendarSyncs.findFirst({
    where: and(eq(calendarSyncs.userId, user.id), eq(calendarSyncs.matchId, matchId)),
  });
  if (!existing) return;

  if (existing.externalEventId) {
    const token = await (deps.getToken ?? getValidAccessToken)(env, db, user);
    await (deps.client ?? getClient(user.provider)).remove(token, existing.externalEventId);
  }

  await db.delete(calendarSyncs).where(eq(calendarSyncs.id, existing.id));
}

// Un partido que empezó hace más de esto se considera jugado: no se corrige su evento (D9)
const HORAS_PARTIDO_JUGADO = 3;

// Marca como needs_update los eventos que quedaron desactualizados respecto del partido: cambió la
// fecha u hora, la sede, o pasó a postergado/cancelado (o volvió de cancelado). Sin userId procesa a
// todos los usuarios. Pocos UPDATE set-based, sin importar cuántos eventos haya.
export async function markOutdatedEvents(db: Database, userId?: string, now: Date = new Date()): Promise<number> {
  const delUsuario = userId ? eq(calendarSyncs.userId, userId) : undefined;
  const sincronizados = and(delUsuario, eq(calendarSyncs.status, "synced"));

  const partido = (columna: unknown) =>
    sql`(SELECT ${columna} FROM ${matches} WHERE ${matches.id} = ${calendarSyncs.matchId})`;
  const fechaActual = partido(matches.dateTime);
  const sedeActual = partido(sql`NULLIF(${matches.venue}, '')`);
  // live y finished no cambian lo que se ve en el calendario: cuentan como scheduled
  const estadoActual = partido(
    sql`CASE WHEN ${matches.status} IN ('postponed','cancelled') THEN ${matches.status} ELSE 'scheduled' END`
  );

  // Eventos creados antes de guardar la fecha o el estado: asumimos que están al día
  await db
    .update(calendarSyncs)
    .set({ syncedDateTime: fechaActual })
    .where(and(sincronizados, isNull(calendarSyncs.syncedDateTime)));
  await db
    .update(calendarSyncs)
    .set({ syncedState: estadoActual })
    .where(and(sincronizados, isNull(calendarSyncs.syncedState)));

  // Solo partidos que no se jugaron todavía (D9)
  const limiteJugado = Math.floor(now.getTime() / 1000) - HORAS_PARTIDO_JUGADO * 3600;
  const sinJugar = sql`${fechaActual} >= ${limiteJugado}`;

  // IS NOT compara bien los NULL (sede vacía)
  const desactualizados = await db
    .update(calendarSyncs)
    .set({ status: "needs_update" })
    .where(
      and(
        sincronizados,
        sinJugar,
        sql`(${calendarSyncs.syncedDateTime} IS NOT ${fechaActual}
          OR ${calendarSyncs.syncedState} IS NOT ${estadoActual}
          OR ${calendarSyncs.syncedVenue} IS NOT ${sedeActual})`
      )
    )
    .returning({ id: calendarSyncs.id });

  // Un partido cancelado que vuelve a jugarse: hay que crear el evento de nuevo (B6)
  const revividos = await db
    .update(calendarSyncs)
    .set({ status: "needs_update" })
    .where(
      and(delUsuario, eq(calendarSyncs.status, "cancelled"), sinJugar, sql`${estadoActual} != 'cancelled'`)
    )
    .returning({ id: calendarSyncs.id });

  return desactualizados.length + revividos.length;
}

export interface ReconcileOptions {
  now?: Date;
  maxUsers?: number;
  matchesPerUser?: number;
}

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
    .orderBy(asc(matches.dateTime))
    .limit(limit);
  return rows.map((r) => r.matchId);
}

// Usuarios a atender: los que tienen eventos para corregir y los que tienen auto-sync, empezando por
// los que más pendientes tienen (así nadie queda sin atender para siempre cuando hay más usuarios que el límite).
async function reconcileCandidates(db: Database, now: Date, maxUsers: number): Promise<string[]> {
  const limiteJugado = new Date(now.getTime() - HORAS_PARTIDO_JUGADO * 3600 * 1000);
  const pendientes = await db
    .select({ userId: calendarSyncs.userId, n: sql<number>`count(*)` })
    .from(calendarSyncs)
    .innerJoin(matches, eq(matches.id, calendarSyncs.matchId))
    .where(and(inArray(calendarSyncs.status, ["needs_update", "failed"]), gte(matches.dateTime, limiteJugado)))
    .groupBy(calendarSyncs.userId);
  const conAutoSync = await db
    .selectDistinct({ userId: userTeams.userId })
    .from(userTeams)
    .where(eq(userTeams.autoSync, true));

  const cantidad = new Map<string, number>();
  for (const { userId } of conAutoSync) cantidad.set(userId, 0);
  for (const { userId, n } of pendientes) cantidad.set(userId, Number(n));

  return [...cantidad.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxUsers)
    .map(([userId]) => userId);
}

// Job diario: detecta los eventos desactualizados de todos los usuarios, los corrige y da de alta
// los partidos pendientes de los equipos con auto-sync (D12).
export async function reconcileCalendars(
  env: Env,
  db: Database,
  deps?: SyncDeps,
  options: ReconcileOptions = {}
): Promise<void> {
  const now = options.now ?? new Date();
  const perUser = options.matchesPerUser ?? CRON_MATCHES_PER_USER;

  await markOutdatedEvents(db, undefined, now);

  for (const userId of await reconcileCandidates(db, now, options.maxUsers ?? CRON_MAX_USERS)) {
    try {
      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      if (!user) continue;

      // Primero las correcciones: valen más que las altas nuevas
      const pendientes = await pendingMatchIds(db, user.id, now, perUser);
      const nuevos = await getAutoSyncMatchIds(db, user.id, perUser);
      const ids = [...new Set([...pendientes, ...nuevos])].slice(0, perUser);
      if (ids.length === 0) continue;

      const results = await syncMatches(db, env, user, ids, { mode: "auto", deps });
      const ok = results.filter((r) => r.success).length;
      rootLogger.info("calendar_reconcile_user", { provider: user.provider, ok, total: results.length });
    } catch (error) {
      rootLogger.error("calendar_reconcile_user_failed", { userId, err: error });
    }
  }
}
