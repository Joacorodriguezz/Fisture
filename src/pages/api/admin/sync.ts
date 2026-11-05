import type { APIRoute } from "astro";
import { runSync } from "../../../lib/observability/run-sync";
import { runCalendarBatch } from "../../../lib/observability/run-calendar-batch";
import { verificarAdmin } from "../../../lib/observability/admin-auth";
import { withApi } from "../../../lib/observability/with-api";
import { lotesDeSync } from "../../../lib/data-providers";

export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;

  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;

  // Opcional: una sola competencia ({"leagueId": "eng.1"}), un lote de competencias ({"lote": 0},
  // docs/22 D4) o un lote de la reconciliación de calendarios ({"calendarios": true, "corte": 1700...},
  // docs/17). Sin nada sincroniza todas las competencias en la misma invocación (sirve en local; en
  // Workers Free no alcanza).
  const body = ((await request.json().catch(() => ({}))) ?? {}) as {
    leagueId?: string;
    lote?: unknown;
    calendarios?: unknown;
    corte?: unknown;
    incompleto?: unknown;
  };

  if (body.calendarios === true) {
    if (body.corte !== undefined && (typeof body.corte !== "number" || !Number.isInteger(body.corte) || body.corte <= 0)) {
      return Response.json({ success: false, error: "corte debe ser un entero positivo (epoch en ms)" }, { status: 400 });
    }
    if (body.incompleto === true && body.corte === undefined) {
      return Response.json({ success: false, error: "incompleto exige el corte del barrido" }, { status: 400 });
    }
    const lote = await runCalendarBatch(env, { corte: body.corte, incompleto: body.incompleto === true, logger: locals.logger });
    if (lote.status === "failed") {
      return Response.json({ success: false, kind: "calendars", runId: lote.runId, error: lote.error }, { status: 500 });
    }
    return Response.json({
      success: true,
      kind: "calendars",
      runId: lote.runId,
      status: lote.status,
      corte: lote.corte,
      siguiente: lote.siguiente,
      ...lote.resumen,
    });
  }

  let lote: number | undefined;
  if (body.lote !== undefined) {
    const total = lotesDeSync().length;
    if (typeof body.lote !== "number" || !Number.isInteger(body.lote) || body.lote < 0 || body.lote >= total) {
      return Response.json({ success: false, error: `lote debe ser un entero entre 0 y ${total - 1}` }, { status: 400 });
    }
    lote = body.lote;
  }

  const outcome = await runSync(env, "admin", { leagueId: body.leagueId, lote, logger: locals.logger });

  if (outcome.status === "failed" && outcome.error) {
    return Response.json({ success: false, runId: outcome.runId, error: outcome.error }, { status: 500 });
  }

  return Response.json({
    success: true,
    runId: outcome.runId,
    status: outcome.status,
    ...(outcome.lote ?? {}),
    results: outcome.results,
    issues: outcome.issues,
  });
}, { origin: "none", contentType: "any", rateLimit: [] });
