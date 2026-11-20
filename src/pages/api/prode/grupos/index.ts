import type { APIRoute } from "astro";
import { withApi } from "../../../../lib/observability/with-api";
import { crearGrupo } from "../../../../lib/prode/repo";
import { normalizarNombreGrupo } from "../../../../lib/prode/reglas";
import { error, json, leerJson, sinSesion } from "../../../../lib/prode/api";

// Crea un grupo del prode: { nombre, ligaId } -> 201 { id, codigo } (docs/37 §3.4)
export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return sinSesion();

  const body = await leerJson(request);
  if (!body || typeof body !== "object") return error("cuerpo_invalido", 400);
  const { nombre, ligaId } = body as { nombre?: unknown; ligaId?: unknown };
  const nombreLimpio = normalizarNombreGrupo(nombre);
  if (!nombreLimpio) return error("nombre_invalido", 400);
  if (typeof ligaId !== "string" || !ligaId) return error("liga_invalida", 400);

  const r = await crearGrupo(locals.runtime.env.DB, { userId: user.id, nombre: nombreLimpio, ligaId, ahora: new Date() });
  if (!r.ok) return error(r.error, r.error === "limite_grupos" ? 409 : 400);
  locals.logger?.info("prode_grupo_creado", { grupoId: r.id });
  return json({ id: r.id, codigo: r.codigo }, 201);
}, { rateLimit: ["mutation_ip", "prode_crear"] });
