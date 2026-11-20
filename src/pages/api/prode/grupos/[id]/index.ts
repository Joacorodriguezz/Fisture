import type { APIRoute } from "astro";
import { withApi } from "../../../../../lib/observability/with-api";
import { borrarGrupo } from "../../../../../lib/prode/repo";
import { errorDeGrupo, sinSesion } from "../../../../../lib/prode/api";

// Borra el grupo (solo quien lo administra). Los pronósticos son de cada usuario y quedan (docs/37 D8)
export const DELETE: APIRoute = withApi(async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return sinSesion();

  const r = await borrarGrupo(locals.runtime.env.DB, params.id ?? "", user.id);
  if (!r.ok) return errorDeGrupo(r.error);
  locals.logger?.info("prode_grupo_borrado", { grupoId: params.id });
  return new Response(null, { status: 204 });
}, { rateLimit: ["mutation_ip", "mutation"] });
