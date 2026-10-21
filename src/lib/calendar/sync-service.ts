// Sincronización de partidos con el calendario del usuario (Google / Microsoft).
// La usan la API (/api/calendario/*) y el cron diario (functions/scheduled.ts).
// Diseño y decisiones: docs/11-calendario-casos-borde-tdd.md

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
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

// Marca como needs_update los eventos cuyo partido cambió de fecha u hora.
// Dos UPDATE set-based en vez de uno por evento (antes: 1 SELECT + N UPDATE en cada vista de página).
export async function markOutdatedEvents(db: Database, userId: string): Promise<number> {
  const sincronizados = and(eq(calendarSyncs.userId, userId), eq(calendarSyncs.status, "synced"));
  const fechaActual = sql`(SELECT ${matches.dateTime} FROM ${matches} WHERE ${matches.id} = ${calendarSyncs.matchId})`;

  // Eventos creados antes de guardar syncedDateTime: asumimos que están al día
  await db
    .update(calendarSyncs)
    .set({ syncedDateTime: fechaActual })
    .where(and(sincronizados, isNull(calendarSyncs.syncedDateTime)));

  const desactualizados = await db
    .update(calendarSyncs)
    .set({ status: "needs_update" })
    .where(and(sincronizados, isNotNull(calendarSyncs.syncedDateTime), sql`${calendarSyncs.syncedDateTime} != ${fechaActual}`))
    .returning({ id: calendarSyncs.id });

  return desactualizados.length;
}

// Job diario: reconcilia eventos desactualizados y sincroniza los partidos pendientes
export async function runCalendarAutoSync(env: Env, db: Database): Promise<void> {
  // Usuarios con al menos un equipo con auto-sync activado
  const candidates = await db
    .selectDistinct({ userId: userTeams.userId })
    .from(userTeams)
    .where(eq(userTeams.autoSync, true))
    .limit(CRON_MAX_USERS);

  for (const { userId } of candidates) {
    try {
      const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
      if (!user) continue;

      await markOutdatedEvents(db, user.id);
      const ids = await getAutoSyncMatchIds(db, user.id, CRON_MATCHES_PER_USER);
      if (ids.length === 0) continue;

      const results = await syncMatches(db, env, user, ids, { mode: "auto" });
      const ok = results.filter((r) => r.success).length;
      rootLogger.info("calendar_autosync_user", { provider: user.provider, ok, total: results.length });
    } catch (error) {
      rootLogger.error("calendar_autosync_user_failed", { userId, err: error });
    }
  }
}
