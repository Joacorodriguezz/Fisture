import type { APIRoute } from "astro";
import { pasadaDelProde } from "../../../../lib/data-providers/prode-pasadas";
import { verificarAdmin } from "../../../../lib/observability/admin-auth";
import { withApi } from "../../../../lib/observability/with-api";

// Pasada del prode tras el final de los partidos (docs/40 D4), que dispara prode-sync.yml cada 15 minutos.
// Sin pendientes cuesta una lectura; con trabajo queda registrada en sync_runs como "prode".
export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;

  const pasada = await pasadaDelProde(env, { logger: locals.logger });
  if (!pasada.trabajo) return Response.json({ success: true, trabajo: false });
  const success = pasada.status !== "failed";
  return Response.json({ success, ...pasada }, { status: success ? 200 : 500 });
}, { origin: "none", contentType: "any", rateLimit: [] });
