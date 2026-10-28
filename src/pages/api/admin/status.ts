import type { APIRoute } from "astro";
import { getHealth } from "../../../lib/observability/health";
import { getLatestRuns } from "../../../lib/observability/sync-runs";
import { isAdminAuthorized, unauthorized } from "../../../lib/observability/admin-auth";
import { createDb } from "../../../lib/db";
import { countSessions } from "../../../lib/auth/session";
import { withApi } from "../../../lib/observability/with-api";

// Detalle para administración: salud, últimos 20 runs del sync y conteo de sesiones (docs/21 Q2).
export const GET: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  if (!isAdminAuthorized(request, env.ADMIN_SECRET)) return unauthorized();

  const db = createDb(env.DB);
  const [health, runs, sessions] = await Promise.all([getHealth(env), getLatestRuns(db, 20), countSessions(db)]);
  return Response.json({ health, runs, sessions }, { headers: { "Cache-Control": "no-store" } });
});
