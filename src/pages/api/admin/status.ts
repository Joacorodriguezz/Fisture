import type { APIRoute } from "astro";
import { getHealth } from "../../../lib/observability/health";
import { getLatestRuns } from "../../../lib/observability/sync-runs";
import { verificarAdmin } from "../../../lib/observability/admin-auth";
import { createDb } from "../../../lib/db";
import { countSessions } from "../../../lib/auth/session";
import { withApi } from "../../../lib/observability/with-api";
import { getMetricas } from "../../../lib/observability/metricas";
import { resultadoAutoHabilitado } from "../../../lib/prode/puntos";
import { metricasRateLimit } from "../../../lib/rate-limit/metricas";
import { contarTokensSinCifrar } from "../../../lib/auth/token-backfill";

// Detalle para administración: salud, últimos 20 runs de ligas, 10 de calendarios y 10 del prode, conteo de
// sesiones (docs/21 Q2) y métricas de producto agregadas (sin ids ni emails).
export const GET: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;

  const db = createDb(env.DB);
  const [health, runs, runsCalendarios, runsProde, sessions, metricas, rateLimit, tokensSinCifrar] = await Promise.all([
    getHealth(env),
    getLatestRuns(db, 20, "leagues"),
    getLatestRuns(db, 10, "calendars"),
    getLatestRuns(db, 10, "prode"),
    countSessions(db),
    getMetricas(db, Date.now(), resultadoAutoHabilitado(env)),
    metricasRateLimit(env.DB).catch(() => null),
    contarTokensSinCifrar(db),
  ]);
  return Response.json(
    { health, runs, runsCalendarios, runsProde, sessions, metricas, rateLimit, tokensSinCifrar },
    { headers: { "Cache-Control": "no-store" } }
  );
}, { rateLimit: [] });
