// Sincronización de partidos con el calendario del usuario (Google / Microsoft).
// La usan la API (/api/calendario/*) y el cron diario (functions/scheduled.ts).

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { calendarSyncs, matches, users, userTeams } from "../../../drizzle/schema";
import { getValidAccessToken } from "../auth/tokens";
import type { Database } from "../db";
import { rootLogger } from "../observability/logger";
import { getMatchDetail, getAutoSyncMatchIds } from "../db/queries";
import { getPreferences, reminderMinutes, type Preferences } from "../db/preferences";
import {
  createGoogleCalendarEvent,
  updateGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  formatMatchForGoogle,
} from "./google";
import {
  createMicrosoftCalendarEvent,
  updateMicrosoftCalendarEvent,
  deleteMicrosoftCalendarEvent,
  formatMatchForMicrosoft,
} from "./microsoft";

type DbUser = typeof users.$inferSelect;
type MatchDetail = NonNullable<Awaited<ReturnType<typeof getMatchDetail>>>;

export interface SyncResult {
  matchId: string;
  success: boolean;
  error?: string;
}

// Límites del cron: cada partido es una llamada a la API de calendario.
// Cloudflare Workers limita las subrequests por invocación.
const CRON_MAX_USERS = 20;
const CRON_MATCHES_PER_USER = 10;

interface CalendarClient {
  create(token: string, match: MatchDetail, prefs: Preferences): Promise<string>;
  update(token: string, eventId: string, match: MatchDetail, prefs: Preferences): Promise<void>;
  remove(token: string, eventId: string): Promise<void>;
}

function getClient(provider: string): CalendarClient {
  if (provider === "google") {
    return {
      async create(token, m, prefs) {
        const event = formatMatchForGoogle(
          m.homeTeam.name,
          m.awayTeam.name,
          m.league.name,
          new Date(m.match.dateTime),
          m.match.venue,
          reminderMinutes(prefs)
        );
        return (await createGoogleCalendarEvent(token, event)).id;
      },
      async update(token, eventId, m, prefs) {
        const event = formatMatchForGoogle(
          m.homeTeam.name,
          m.awayTeam.name,
          m.league.name,
          new Date(m.match.dateTime),
          m.match.venue,
          reminderMinutes(prefs)
        );
        await updateGoogleCalendarEvent(token, eventId, event);
      },
      remove: (token, eventId) => deleteGoogleCalendarEvent(token, eventId),
    };
  }

  if (provider === "microsoft") {
    return {
      async create(token, m, prefs) {
        const event = formatMatchForMicrosoft(
          m.homeTeam.name,
          m.awayTeam.name,
          m.league.name,
          new Date(m.match.dateTime),
          m.match.venue,
          reminderMinutes(prefs)
        );
        return (await createMicrosoftCalendarEvent(token, event)).id;
      },
      async update(token, eventId, m, prefs) {
        const event = formatMatchForMicrosoft(
          m.homeTeam.name,
          m.awayTeam.name,
          m.league.name,
          new Date(m.match.dateTime),
          m.match.venue,
          reminderMinutes(prefs)
        );
        await updateMicrosoftCalendarEvent(token, eventId, event);
      },
      remove: (token, eventId) => deleteMicrosoftCalendarEvent(token, eventId),
    };
  }

  throw new Error("Proveedor de calendario no soportado");
}

async function saveState(
  db: Database,
  userId: string,
  provider: string,
  matchId: string,
  values: Partial<typeof calendarSyncs.$inferInsert>
) {
  const existing = await db.query.calendarSyncs.findFirst({
    where: and(eq(calendarSyncs.userId, userId), eq(calendarSyncs.matchId, matchId)),
  });

  if (existing) {
    await db.update(calendarSyncs).set(values).where(eq(calendarSyncs.id, existing.id));
  } else {
    await db.insert(calendarSyncs).values({ userId, provider, matchId, ...values });
  }
}

// Crea o actualiza el evento de cada partido en el calendario del usuario
export async function syncMatches(
  db: Database,
  env: Env,
  user: DbUser,
  matchIds: string[]
): Promise<SyncResult[]> {
  const prefs = await getPreferences(db, user.id);
  const client = getClient(user.provider);
  const results: SyncResult[] = [];

  for (const matchId of matchIds) {
    try {
      const match = await getMatchDetail(db, matchId);
      if (!match) {
        results.push({ matchId, success: false, error: "Partido no encontrado" });
        continue;
      }

      const existing = await db.query.calendarSyncs.findFirst({
        where: and(eq(calendarSyncs.userId, user.id), eq(calendarSyncs.matchId, matchId)),
      });

      const kickoff = match.match.dateTime.getTime();
      const upToDate =
        existing?.status === "synced" && existing.syncedDateTime?.getTime() === kickoff;
      if (upToDate) {
        results.push({ matchId, success: true });
        continue;
      }

      const token = await getValidAccessToken(env, db, user);

      let externalEventId: string;
      if (existing?.externalEventId) {
        // El evento existe (horario cambiado): lo actualizamos en lugar de duplicarlo
        try {
          await client.update(token, existing.externalEventId, match, prefs);
          externalEventId = existing.externalEventId;
        } catch {
          // Si el evento fue borrado desde el calendario, lo creamos de nuevo
          externalEventId = await client.create(token, match, prefs);
        }
      } else {
        externalEventId = await client.create(token, match, prefs);
      }

      await saveState(db, user.id, user.provider, matchId, {
        externalEventId,
        status: "synced",
        syncedDateTime: match.match.dateTime,
        lastSyncedAt: new Date(),
        errorMessage: null,
      });

      results.push({ matchId, success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Error desconocido";
      rootLogger.error("calendar_match_sync_failed", { matchId, message });

      await saveState(db, user.id, user.provider, matchId, {
        status: "failed",
        errorMessage: message,
      });

      results.push({ matchId, success: false, error: message });
    }
  }

  return results;
}

// Borra el evento del calendario y deja de tratar el partido como sincronizado
export async function removeMatchFromCalendar(
  db: Database,
  env: Env,
  user: DbUser,
  matchId: string
): Promise<void> {
  const existing = await db.query.calendarSyncs.findFirst({
    where: and(eq(calendarSyncs.userId, user.id), eq(calendarSyncs.matchId, matchId)),
  });
  if (!existing) return;

  if (existing.externalEventId) {
    const token = await getValidAccessToken(env, db, user);
    await getClient(user.provider).remove(token, existing.externalEventId);
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

      const results = await syncMatches(db, env, user, ids);
      const ok = results.filter((r) => r.success).length;
      rootLogger.info("calendar_autosync_user", { provider: user.provider, ok, total: results.length });
    } catch (error) {
      rootLogger.error("calendar_autosync_user_failed", { userId, err: error });
    }
  }
}
