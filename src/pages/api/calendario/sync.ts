import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import {
  syncMatches,
  removeMatchFromCalendar,
  MENSAJES_CORTE,
} from "../../../lib/calendar/sync-service";
import { CalendarApiError, classifyCalendarError } from "../../../lib/calendar/errors";
import { withApi } from "../../../lib/observability/with-api";
import { mensajeDeError } from "../../../lib/observability/logger";
import { MAX_PARTIDOS_POR_REQUEST } from "../../../lib/calendar/limites";

const MAX_MATCH_IDS = MAX_PARTIDOS_POR_REQUEST;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Agrega o actualiza uno o varios partidos en el calendario del usuario
export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "matchId or matchIds required" }, 400);
  }
  const { matchId, matchIds } = body as { matchId?: unknown; matchIds?: unknown };
  const validId = (id: unknown): id is string => typeof id === "string" && id.trim().length > 0;
  const idsToSync = matchIds !== undefined ? matchIds : validId(matchId) ? [matchId] : [];
  if (!Array.isArray(idsToSync) || idsToSync.length === 0 || !idsToSync.every(validId)) {
    return json({ error: "matchId or matchIds required" }, 400);
  }

  // Tope por request (docs/16 R2): el máximo sale del presupuesto de subrequests de Workers Free (lib/calendar/limites.ts)
  if (idsToSync.length > MAX_MATCH_IDS) {
    return json({ error: "too_many_matchIds", max: MAX_MATCH_IDS }, 400);
  }

  const env = locals.runtime.env;
  const db = createDb(env.DB);
  const results = await syncMatches(db, env, user, idsToSync);
  const allSuccess = results.every((r) => r.success);

  return json({ success: allSuccess, results }, allSuccess ? 200 : 207);
}, { rateLimit: ["calendar_sync_ip", "calendar_sync", "calendar_sync_hour"] });

// Quita el evento del partido del calendario del usuario
export const DELETE: APIRoute = withApi(async ({ url, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const matchId = url.searchParams.get("matchId");
  if (!matchId) return json({ error: "matchId required" }, 400);

  const env = locals.runtime.env;
  const db = createDb(env.DB);

  try {
    await removeMatchFromCalendar(db, env, user, matchId);
    return json({ success: true });
  } catch (error) {
    // Reconectar (token ilegible, 401 o falta de permiso): misma señal que POST (code y tokenInvalido, docs/11 D4),
    // pero 401 y no 207: un 2xx lo tomaría el cliente como "quitado". La fila se conserva: el evento sigue en el
    // calendario del usuario y, al reconectar, el próximo "Quitar" lo borra. No marca reauth_required: como en
    // POST, lo hace el cron (reconcile) al ver el mismo token
    const code = classifyCalendarError(error);
    if (code === "auth" || code === "scope") {
      const tokenInvalido = (code === "auth" && !(error instanceof CalendarApiError)) || code === "scope";
      locals.logger?.warn("calendar_remove_reauth", { matchId, code });
      return json({ success: false, error: MENSAJES_CORTE[code], code, ...(tokenInvalido && { tokenInvalido }) }, 401);
    }
    const message = mensajeDeError(error, "Error desconocido");
    return json({ success: false, error: message }, 500);
  }
}, { rateLimit: ["mutation_ip", "calendar_delete"] });
