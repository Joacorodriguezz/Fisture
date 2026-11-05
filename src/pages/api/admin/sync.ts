import type { APIRoute } from "astro";
import { runSync } from "../../../lib/observability/run-sync";
import { verificarAdmin } from "../../../lib/observability/admin-auth";
import { withApi } from "../../../lib/observability/with-api";
import { lotesDeSync } from "../../../lib/data-providers";

export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;

  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;

  // Opcional: una sola competencia ({"leagueId": "eng.1"}) o un lote ({"lote": 0}, docs/22 D4).
  // Sin nada sincroniza todas en la misma invocación (sirve en local; en Workers Free no alcanza).
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { leagueId?: string; lote?: unknown };

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
