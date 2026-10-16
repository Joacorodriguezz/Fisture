import type { APIRoute } from "astro";
import { runSync } from "../../../lib/observability/run-sync";
import { isAdminAuthorized, unauthorized } from "../../../lib/observability/admin-auth";
import { withApi } from "../../../lib/observability/with-api";

export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;

  if (!isAdminAuthorized(request, env.ADMIN_SECRET)) return unauthorized();

  // Opcional: sincronizar solo una liga específica
  const body = ((await request.json().catch(() => ({}))) ?? {}) as { leagueId?: string };

  const outcome = await runSync(env, "admin", { leagueId: body.leagueId, logger: locals.logger });

  if (outcome.status === "failed" && outcome.error) {
    return Response.json({ success: false, runId: outcome.runId, error: outcome.error }, { status: 500 });
  }

  return Response.json({
    success: true,
    runId: outcome.runId,
    status: outcome.status,
    results: outcome.results,
    issues: outcome.issues,
  });
});
