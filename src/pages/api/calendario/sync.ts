import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import {
  syncMatches,
  removeMatchFromCalendar,
} from "../../../lib/calendar/sync-service";
import { withApi } from "../../../lib/observability/with-api";

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

  const env = locals.runtime.env;
  const db = createDb(env.DB);
  const results = await syncMatches(db, env, user, idsToSync);
  const allSuccess = results.every((r) => r.success);

  return json({ success: allSuccess, results }, allSuccess ? 200 : 207);
});

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
    const message = error instanceof Error ? error.message : "Error desconocido";
    return json({ success: false, error: message }, 500);
  }
});
