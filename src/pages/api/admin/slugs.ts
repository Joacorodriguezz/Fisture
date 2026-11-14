import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { asignarSlugsPendientes } from "../../../lib/db/slugs";
import { verificarAdmin } from "../../../lib/observability/admin-auth";
import { withApi } from "../../../lib/observability/with-api";

// Backfill de los slugs de equipos y ligas (docs/33 D9). Bearer ADMIN_SECRET. Cada llamada asigna slug a un
// lote acotado de filas sin slug (ligas primero, después equipos) y responde `pendientes`: repetir hasta
// que sea 0. Idempotente: nunca cambia un slug ya asignado. Una URL con id de una fila con slug pasa a
// responder 301 a la URL con nombre en el momento en que la fila recibe su slug.
export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;

  const resultado = await asignarSlugsPendientes(createDb(env.DB));
  // Solo conteos: los nombres de equipos no hacen falta en el log
  locals.logger?.info("slug_backfill", { ...resultado.asignados, pendientes: resultado.pendientes });
  return Response.json(resultado, { headers: { "Cache-Control": "no-store" } });
}, { origin: "none", contentType: "any", rateLimit: [] });
