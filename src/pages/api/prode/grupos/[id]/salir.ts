import type { APIRoute } from "astro";
import { withApi } from "../../../../../lib/observability/with-api";
import { salirDeGrupo } from "../../../../../lib/prode/repo";
import { errorDeGrupo, json, sinSesion } from "../../../../../lib/prode/api";

// Sale del grupo. Si sale el dueño, administra el miembro más antiguo; si sale el último, el grupo se
// borra (docs/37 D8)
export const POST: APIRoute = withApi(async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return sinSesion();

  const r = await salirDeGrupo(locals.runtime.env.DB, params.id ?? "", user.id);
  if (!r.ok) return errorDeGrupo(r.error);
  return json({ grupoBorrado: r.grupoBorrado });
}, { rateLimit: ["mutation_ip", "mutation"] });
