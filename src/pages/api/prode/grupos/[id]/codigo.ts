import type { APIRoute } from "astro";
import { withApi } from "../../../../../lib/observability/with-api";
import { regenerarCodigo } from "../../../../../lib/prode/repo";
import { errorDeGrupo, json, sinSesion } from "../../../../../lib/prode/api";

// Código de invitación nuevo: el link anterior deja de funcionar (docs/37 D8)
export const POST: APIRoute = withApi(async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return sinSesion();

  const r = await regenerarCodigo(locals.runtime.env.DB, params.id ?? "", user.id);
  if (!r.ok) return errorDeGrupo(r.error);
  return json({ codigo: r.codigo });
}, { rateLimit: ["mutation_ip", "mutation"] });
