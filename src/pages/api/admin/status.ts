import type { APIRoute } from "astro";
import { getHealth } from "../../../lib/observability/health";
import { getLatestRuns } from "../../../lib/observability/sync-runs";
import { isAdminAuthorized, unauthorized } from "../../../lib/observability/admin-auth";
import { createDb } from "../../../lib/db";
import { countSessions } from "../../../lib/auth/session";
import { withApi } from "../../../lib/observability/with-api";
import { getMetricas } from "../../../lib/observability/metricas";
import { contarTokensSinCifrar } from "../../../lib/auth/token-backfill";

// Detalle para administración: salud, últimos 20 runs de ligas y 10 de calendarios, conteo de
// sesiones (docs/21 Q2) y métricas de producto agregadas (sin ids ni emails).
export const GET: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  if (!isAdminAuthorized(request, env.ADMIN_SECRET)) return unauthorized();

  const db = createDb(env.DB);
  const [health, runs, runsCalendarios, sessions, metricas, tokensSinCifrar] = await Promise.all([
    getHealth(env),
    getLatestRuns(db, 20, "leagues"),
    getLatestRuns(db, 10, "calendars"),
    countSessions(db),
    getMetricas(db),
    contarTokensSinCifrar(db),
  ]);
  return Response.json(
    { health, runs, runsCalendarios, sessions, metricas, tokensSinCifrar },
    { headers: { "Cache-Control": "no-store" } }
  );
});
