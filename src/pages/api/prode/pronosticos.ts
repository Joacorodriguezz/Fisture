import type { APIRoute } from "astro";
import { withApi } from "../../../lib/observability/with-api";
import { guardarPronosticos } from "../../../lib/prode/repo";
import { MAX_PRONOSTICOS_POR_REQUEST, interpretarPronosticos } from "../../../lib/prode/reglas";
import { error, json, leerJson, sinSesion } from "../../../lib/prode/api";

// Guarda los pronósticos del usuario: { pronosticos: [{ partidoId, local, visitante }] } (null y null
// borra). Respuesta parcial: lo que se pudo guardar se guarda y cada rechazo dice por qué (docs/37 §3.4).
// El cierre lo decide el reloj del servidor, dentro del SQL (docs/37 D2).
export const PUT: APIRoute = withApi(async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return sinSesion();

  const entrada = interpretarPronosticos(await leerJson(request));
  if (!entrada.ok) {
    return entrada.error === "demasiados_pronosticos"
      ? error(entrada.error, 400, { maximo: MAX_PRONOSTICOS_POR_REQUEST })
      : error(entrada.error, 400);
  }

  const r = await guardarPronosticos(locals.runtime.env.DB, user.id, entrada.entradas, new Date());
  const rechazados = [...entrada.invalidos.map((partidoId) => ({ partidoId, motivo: "invalido" as const })), ...r.rechazados];
  locals.logger.info("prode_pronosticos", { guardados: r.guardados.length, borrados: r.borrados.length, rechazados: rechazados.length });
  return json({ guardados: r.guardados, borrados: r.borrados, rechazados });
}, { rateLimit: ["mutation_ip", "prode_pronosticar"] });
