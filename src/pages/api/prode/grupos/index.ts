import type { APIRoute } from "astro";
import { createDb } from "../../../../lib/db";
import { crearGrupo, misGrupos, NOMBRE_MAX, NOMBRE_MIN } from "../../../../lib/prode/grupos";
import { withApi } from "../../../../lib/observability/with-api";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

// Grupos del prode donde participa el usuario
export const GET: APIRoute = withApi(async ({ locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const db = createDb(locals.runtime.env.DB);
  return json({ grupos: await misGrupos(db, user.id) });
}, { rateLimit: [] });

// Crea un grupo con { nombre }. Devuelve el código de invitación para armar el enlace
export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: "Unauthorized" }, 401);

  const body = (await request.json().catch(() => null)) as { nombre?: unknown } | null;
  const db = createDb(locals.runtime.env.DB);
  const grupo = await crearGrupo(db, user.id, body?.nombre);
  if (!grupo) return json({ error: `El nombre debe tener entre ${NOMBRE_MIN} y ${NOMBRE_MAX} caracteres` }, 400);

  locals.logger?.info("prode_grupo_creado", { groupId: grupo.id });
  return json(grupo, 201);
}, { rateLimit: ["mutation_ip", "mutation"] });
