import type { APIRoute } from "astro";
import { withApi } from "../../../../../../lib/observability/with-api";
import { expulsarMiembro } from "../../../../../../lib/prode/repo";
import { errorDeGrupo, sinSesion } from "../../../../../../lib/prode/api";

// Saca a un miembro del grupo (solo quien lo administra, nunca a sí mismo: para eso está salir)
export const DELETE: APIRoute = withApi(async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return sinSesion();

  const r = await expulsarMiembro(locals.runtime.env.DB, params.id ?? "", user.id, params.userId ?? "");
  if (!r.ok) return errorDeGrupo(r.error);
  return new Response(null, { status: 204 });
}, { rateLimit: ["mutation_ip", "mutation"] });
