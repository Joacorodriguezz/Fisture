// Sincronización de partidos con el calendario del usuario (Google / Microsoft).
// La usan la API (/api/calendario/*) y la reconciliación por lotes (calendar/reconcile.ts).
// Diseño y decisiones: docs/11-calendario-casos-borde-tdd.md

import { and, eq, isNull, sql } from "drizzle-orm";
import { calendarSyncs, matches, users } from "../../../drizzle/schema";
import { getValidAccessToken } from "../auth/tokens";
import type { Database } from "../db";
import { mensajeDeError, rootLogger } from "../observability/logger";
import { getMatchDetail } from "../db/queries";
import { getPreferences } from "../db/preferences";
import { getClient, type CalendarClient, type MatchDetail } from "./clients";
import { CalendarApiError, classifyCalendarError, type CalendarErrorClass } from "./errors";
import { eventState, type OverlapItem } from "./event-state";
import { COSTO_MAX_PARTIDO, COSTO_RENOVACION_401, contarCliente, type Presupuesto } from "./presupuesto";
import type { OpcionesToken } from "../auth/tokens";

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
  // Solo con code "auth": el fallo vino del token (invalid_grant, sin refresh o access token) y no de un
  // 401 del proveedor. Solo el primero prueba que hay que volver a conectar (docs/17 B4).
  tokenInvalido?: boolean;
  warnings?: SyncWarning[];
}

// "manual": el usuario lo pidió (clic). "auto": lo corre el cron y no debe resucitar lo que el usuario quitó.
export type SyncMode = "manual" | "auto";

// Dependencias inyectables (los tests reemplazan el proveedor real y el token)
export interface SyncDeps {
  client?: CalendarClient;
  getToken?: (env: Env, db: Database, user: DbUser, opciones?: OpcionesToken) => Promise<string>;
}

export interface SyncOptions {
  mode?: SyncMode;
  deps?: SyncDeps;
  // Solo la reconciliación por lotes: cuenta las llamadas al calendario y se detiene, sin procesar
  // los partidos que quedan, cuando no alcanza para otro partido (docs/17 B5). Quienes no se
  // procesaron no aparecen en el resultado.
  presupuesto?: Presupuesto;
}

export const MENSAJES_CORTE: Partial<Record<CalendarErrorClass, string>> = {
  auth: "Hay que volver a conectar el calendario",
  scope: "Falta el permiso para escribir en tu calendario: volvé a iniciar sesión y aceptá el acceso al calendario",
  rate_limit: "El calendario pidió esperar un rato, reintentá más tarde",
  config: "Servicio no disponible por un problema de configuración, reintentá más tarde",
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

// Si el evento ya existía con otra hora, guarda la anterior para «Horario actualizado» (docs/31 D6).
// Sin cambio de hora no devuelve nada: se conserva lo que ya estaba guardado.
function cambioDeHorario(existing: SyncRow | undefined, snap: Snapshot): SyncedValues {
  const anterior = existing?.syncedDateTime;
  if (!existing?.externalEventId || !anterior || anterior.getTime() === snap.dateTime.getTime()) return {};
  return { previousDateTime: anterior, dateTimeChangedAt: new Date() };
}

function upToDate(existing: SyncRow | undefined, snap: Snapshot): boolean {
  return (
    existing?.status === "synced" &&
    existing.syncedDateTime?.getTime() === snap.dateTime.getTime() &&
    (existing.syncedState ?? "scheduled") === snap.state &&
    (existing.syncedVenue ?? null) === snap.venue
  );
}

// Ante un 401 pide un token nuevo y repite la llamada una vez. `renovar` devuelve undefined si ya se
// renovó antes en esta invocación (la renovación no sirvió: es un problema de acceso, no de token).
function conRenovacionAnte401(client: CalendarClient, renovar: () => Promise<string | undefined>): CalendarClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reintentable = <A extends any[], R>(fn: (token: string, ...args: A) => Promise<R>) =>
    async (token: string, ...args: A): Promise<R> => {
      try {
        return await fn(token, ...args);
      } catch (error) {
        if (error instanceof CalendarApiError && classifyCalendarError(error) === "auth") {
          const nuevo = await renovar();
          if (nuevo) return fn(nuevo, ...args);
        }
        throw error;
      }
    };
  return {
    create: (token, match, prefs, ctx) => reintentable(client.create.bind(client))(token, match, prefs, ctx),
    update: (token, eventId, match, prefs) => reintentable(client.update.bind(client))(token, eventId, match, prefs),
    remove: (token, eventId) => reintentable(client.remove.bind(client))(token, eventId),
    overlaps: (token, match, ownEventId) => client.overlaps(token, match, ownEventId),
  };
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
  const { presupuesto } = options;
  const clienteBase = options.deps?.client ?? getClient(user.provider);
  const tokenBase = options.deps?.getToken ?? getValidAccessToken;

  // El token se obtiene una vez por invocación y se reutiliza (docs/17 I1): pedirlo por partido
  // renovaba un token vencido en cada uno, con el refresh token ya rotado. Renovar es una llamada de red
  // (la consulta que lo guarda ya la cuenta la D1 instrumentada).
  let token: string | undefined;
  let renovadoPorRechazo = false;
  const obtenerToken = async (forzar = false): Promise<string> => {
    if (!forzar && token) return token;
    token = await tokenBase(env, db, user, {
      forzarRenovacion: forzar,
      alRenovar: presupuesto ? () => presupuesto.gastar() : undefined,
    });
    return token;
  };
  // Un 401 con un token que parecía vigente: se renueva y se reintenta una sola vez por invocación
  // (docs/17 I2). Reintentar es seguro: alta, cambio y baja son idempotentes. Solo el 401 reintenta.
  const renovarTrasRechazo = async (): Promise<string | undefined> => {
    if (renovadoPorRechazo) return undefined;
    renovadoPorRechazo = true;
    return obtenerToken(true);
  };
  const client = conRenovacionAnte401(presupuesto ? contarCliente(clienteBase, presupuesto) : clienteBase, renovarTrasRechazo);
  const results: SyncResult[] = [];

  for (let i = 0; i < ids.length; i++) {
    // Sin lugar para otro partido: se frena acá y el resto queda para el próximo lote
    if (presupuesto && !presupuesto.alcanza(COSTO_MAX_PARTIDO + (renovadoPorRechazo ? 0 : COSTO_RENOVACION_401))) break;
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
        results.push(await cancelEvent(db, user, matchId, existing, snap, client, obtenerToken));
        continue;
      }

      const token = await obtenerToken();

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
        ...cambioDeHorario(existing, snap),
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

      if (code === "auth" || code === "scope" || code === "rate_limit" || code === "config") {
        // No es culpa del partido: se corta, no se marca nada como failed y se reintenta cuando se pueda (D4)
        rootLogger.warn("calendar_sync_aborted", { matchId, code, pending: ids.length - i });
        const message = MENSAJES_CORTE[code] ?? "Error desconocido";
        // TokenUnreadableError también cuenta: el token guardado no sirve. La falta de clave (config) no marca a nadie.
        // Sin el permiso de calendario (scope) el usuario tiene que reconectar: queda como reauth_required
        const tokenInvalido = (code === "auth" && !(error instanceof CalendarApiError)) || code === "scope";
        for (const id of ids.slice(i)) results.push({ matchId: id, success: false, error: message, code, ...(tokenInvalido && { tokenInvalido }) });
        break;
      }

      const message = mensajeDeError(error, "Error desconocido");
      rootLogger.error("calendar_match_sync_failed", { matchId, code, message });

      await saveState(db, user.id, user.provider, matchId, {
        status: "failed",
        errorMessage: message,
      });

      results.push({ matchId, success: false, error: message, code });
    }
  }

  // Un alta o cambio a mano que funcionó prueba que el calendario volvió a tener acceso (docs/17 M5)
  if (mode === "manual" && user.calendarAuthStatus === "reauth_required" && results.some((r) => r.success)) {
    await db.update(users).set({ calendarAuthStatus: "ok" }).where(eq(users.id, user.id));
    user.calendarAuthStatus = "ok";
  }

  return results;
}

// Partido cancelado: se quita el evento y la fila queda cancelled (D10)
async function cancelEvent(
  db: Database,
  user: DbUser,
  matchId: string,
  existing: SyncRow | undefined,
  snap: Snapshot,
  client: CalendarClient,
  obtenerToken: () => Promise<string>
): Promise<SyncResult> {
  if (existing?.status === "cancelled") return { matchId, success: true };
  if (!existing) return { matchId, success: false, error: "El partido está cancelado" };

  if (existing.externalEventId) {
    const token = await obtenerToken();
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
export const HORAS_PARTIDO_JUGADO = 3;

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
