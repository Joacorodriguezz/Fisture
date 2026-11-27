import type { APIRoute } from "astro";
import { createDb } from "../../../../lib/db";
import { detalleGrupo } from "../../../../lib/prode/grupos";
import { withApi } from "../../../../lib/observability/with-api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Detalle e integrantes. Un grupo ajeno o inexistente da el mismo 404 (no revela que existe)
export const GET: APIRoute = withApi(async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const db = createDb(locals.runtime.env.DB);
  const grupo = params.id ? await detalleGrupo(db, user.id, params.id) : null;
  if (!grupo) return json({ error: "Not found" }, 404);
  return json(grupo);
}, { rateLimit: [] });
