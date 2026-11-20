import type { APIRoute } from "astro";
import { withApi } from "../../../lib/observability/with-api";
import { unirseAGrupo } from "../../../lib/prode/repo";
import { normalizarCodigo } from "../../../lib/prode/reglas";
import { error, json, leerJson, sinSesion } from "../../../lib/prode/api";

// Une al usuario con el código de invitación: { codigo } -> { grupoId, yaEraMiembro }. Límite por IP y
// por usuario contra la fuerza bruta de códigos (docs/37 D6)
export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return sinSesion();

  const body = await leerJson(request);
  const codigo = normalizarCodigo((body as { codigo?: unknown } | undefined)?.codigo);
  if (!codigo) return error("codigo_invalido", 400);

  const r = await unirseAGrupo(locals.runtime.env.DB, { userId: user.id, codigo, ahora: new Date() });
  if (!r.ok) return error(r.error, r.error === "codigo_inexistente" ? 404 : 409);
  if (!r.yaEraMiembro) locals.logger.info("prode_union", { grupoId: r.grupoId });
  return json({ grupoId: r.grupoId, yaEraMiembro: r.yaEraMiembro });
}, { rateLimit: ["prode_unirse_ip", "prode_unirse"] });
