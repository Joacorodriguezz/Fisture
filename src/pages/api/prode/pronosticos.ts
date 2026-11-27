import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { withApi } from "../../../lib/observability/with-api";
import { guardarPronostico, listarPronosticos } from "../../../lib/prode/pronosticos";

// Pronósticos del prode del usuario con sesión.
// GET: partidos del prode con fase, horario, cierre, estado (abierto/cerrado/jugado) y el pronóstico propio.
// PUT: guarda o modifica un pronóstico ({matchId, homeGoals, awayGoals}, enteros 0-20). Desde el inicio
// del partido (hora del servidor) responde 409 pronostico_cerrado. Con empate hay que sumar
// pasa: "home" | "away" (400 falta_quien_pasa); con un ganador pasa se ignora y se guarda null (docs/40 R2).
const headers = { "Cache-Control": "no-store" };

export const GET: APIRoute = withApi(async ({ locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });
  const partidos = await listarPronosticos(createDb(locals.runtime.env.DB), user.id);
  return Response.json({ partidos }, { headers });
}, { rateLimit: [] });

export const PUT: APIRoute = withApi(async ({ request, locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });

  const datos = await request.json().catch(() => null);
  if (!datos || typeof datos !== "object" || Array.isArray(datos)) {
    return Response.json({ error: "json_invalido" }, { status: 400, headers });
  }

  const resultado = await guardarPronostico(createDb(locals.runtime.env.DB), user.id, datos as Record<string, unknown>);
  if (!resultado.ok) {
    locals.logger?.warn("prode_pronostico_rechazado", { error: resultado.error });
    return Response.json({ error: resultado.error }, { status: resultado.status, headers });
  }
  locals.logger?.info("prode_pronostico_guardado", { matchId: resultado.pronostico.matchId });
  return Response.json({ pronostico: resultado.pronostico }, { headers });
}, { rateLimit: ["mutation_ip", "mutation"] });
