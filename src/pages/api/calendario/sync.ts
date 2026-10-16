import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import {
  syncMatches,
  removeMatchFromCalendar,
} from "../../../lib/calendar/sync-service";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Agrega o actualiza uno o varios partidos en el calendario del usuario
export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = await request.json().catch(() => ({}));
  const { matchId, matchIds } = body as { matchId?: string; matchIds?: string[] };

  const idsToSync: string[] = matchIds || (matchId ? [matchId] : []);
  if (idsToSync.length === 0) {
    return json({ error: "matchId or matchIds required" }, 400);
  }

  const env = locals.runtime.env;
  const db = createDb(env.DB);
  const results = await syncMatches(db, env, user, idsToSync);
  const allSuccess = results.every((r) => r.success);

  return json({ success: allSuccess, results }, allSuccess ? 200 : 207);
};

// Quita el evento del partido del calendario del usuario
export const DELETE: APIRoute = async ({ url, locals }) => {
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
};
