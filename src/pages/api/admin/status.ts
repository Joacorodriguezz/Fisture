import type { APIRoute } from "astro";
import { getHealth } from "../../../lib/observability/health";
import { getLatestRuns } from "../../../lib/observability/sync-runs";
import { verificarAdmin } from "../../../lib/observability/admin-auth";
import { createDb } from "../../../lib/db";
import { countSessions } from "../../../lib/auth/session";
import { withApi } from "../../../lib/observability/with-api";
import { getMetricas } from "../../../lib/observability/metricas";
import { metricasRateLimit } from "../../../lib/rate-limit/metricas";

// Detalle para administración: salud, últimos 20 runs del sync, conteo de sesiones (docs/21 Q2)
// y métricas de producto agregadas (sin ids ni emails).
export const GET: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;

  const db = createDb(env.DB);
  const [health, runs, sessions, metricas, rateLimit] = await Promise.all([
    getHealth(env),
    getLatestRuns(db, 20),
    countSessions(db),
    getMetricas(db),
    metricasRateLimit(env.DB).catch(() => null),
  ]);
  return Response.json({ health, runs, sessions, metricas, rateLimit }, { headers: { "Cache-Control": "no-store" } });
}, { rateLimit: [] });
