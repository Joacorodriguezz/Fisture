import type { APIRoute } from "astro";
import { getHealth } from "../../../lib/observability/health";
import { getLatestRuns } from "../../../lib/observability/sync-runs";
import { isAdminAuthorized, unauthorized } from "../../../lib/observability/admin-auth";
import { createDb } from "../../../lib/db";
import { withApi } from "../../../lib/observability/with-api";

// Detalle para administración: salud + últimos 20 runs del sync con resultados e issues.
export const GET: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  if (!isAdminAuthorized(request, env.ADMIN_SECRET)) return unauthorized();

  const [health, runs] = await Promise.all([getHealth(env), getLatestRuns(createDb(env.DB), 20)]);
  return Response.json({ health, runs }, { headers: { "Cache-Control": "no-store" } });
});
