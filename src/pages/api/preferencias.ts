import type { APIRoute } from "astro";
import { createDb } from "../../lib/db";
import { getPreferences, updatePreferences, type Preferences } from "../../lib/db/preferences";
import { withApi } from "../../lib/observability/with-api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = withApi(async ({ locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const db = createDb(locals.runtime.env.DB);
  return json(await getPreferences(db, user.id));
});

// Acepta cualquier combinación de: reminder60, reminder15 (boolean) y theme
export const PATCH: APIRoute = withApi(async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = (await request.json().catch(() => ({}))) as {
    reminder60?: unknown;
    reminder15?: unknown;
    theme?: unknown;
  };
  const changes: Partial<Preferences> = {};

  if (typeof body.reminder60 === "boolean") changes.reminder60 = body.reminder60;
  if (typeof body.reminder15 === "boolean") changes.reminder15 = body.reminder15;
  if (body.theme === "papel" || body.theme === "nocturna") changes.theme = body.theme;

  if (Object.keys(changes).length === 0) {
    return json({ error: "No valid preferences in body" }, 400);
  }

  const db = createDb(locals.runtime.env.DB);
  const updated = await updatePreferences(db, user.id, changes);
  return json(updated);
});
