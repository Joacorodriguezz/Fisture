import type { APIRoute } from "astro";
import { createDb } from "../../../../lib/db";
import { unirseConCodigo } from "../../../../lib/prode/grupos";
import { withApi } from "../../../../lib/observability/with-api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Se une al grupo con { codigo }. Idempotente. El código nunca se loguea
export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = (await request.json().catch(() => null)) as { codigo?: unknown } | null;
  const db = createDb(locals.runtime.env.DB);
  const grupo = await unirseConCodigo(db, user.id, body?.codigo);
  if (!grupo) {
    locals.logger?.warn("prode_invitacion_invalida");
    return json({ error: "Invitación inválida" }, 404);
  }

  locals.logger?.info("prode_grupo_unido", { groupId: grupo.id });
  return json(grupo);
}, { rateLimit: ["prode_unirse_ip", "prode_unirse"] });
