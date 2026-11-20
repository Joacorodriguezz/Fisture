import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { getNombreVisible, setNombreVisible } from "../../../lib/db/nombre-visible";
import { MENSAJES_NOMBRE, validarNombreVisible } from "../../../lib/prode/nombre-visible";
import { withApi } from "../../../lib/observability/with-api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Nombre visible del prode: lo único que se muestra del participante en posiciones y grupos.
// El nombre nunca se loguea; solo el resultado de la validación.
export const GET: APIRoute = withApi(async ({ locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const db = createDb(locals.runtime.env.DB);
  return json({ nombre: await getNombreVisible(db, user.id) });
}, { rateLimit: [] });

// Cuerpo: { "nombre": "<texto>" }. Responde el nombre normalizado tal como quedó guardado.
export const PUT: APIRoute = withApi(async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = (await request.json().catch(() => null)) as { nombre?: unknown } | null;
  const resultado = validarNombreVisible(body?.nombre);
  if (!resultado.ok) {
    locals.logger?.info("prode.nombre_visible.rechazado", { motivo: resultado.error });
    return json({ error: MENSAJES_NOMBRE[resultado.error], motivo: resultado.error }, 400);
  }

  const db = createDb(locals.runtime.env.DB);
  await setNombreVisible(db, user.id, resultado.nombre);
  locals.logger?.info("prode.nombre_visible.guardado");
  return json({ nombre: resultado.nombre });
}, { rateLimit: ["mutation_ip", "mutation"] });
