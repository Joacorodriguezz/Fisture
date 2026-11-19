import type { APIRoute } from "astro";
import { createDb } from "../../../../lib/db";
import { verificarAdmin } from "../../../../lib/observability/admin-auth";
import { withApi } from "../../../../lib/observability/with-api";
import { agregarCruce, corregirPartido, listarCruces, type Resultado } from "../../../../lib/prode/partidos";

// Cruces del prode de playoffs, carga manual (Bearer ADMIN_SECRET).
// GET lista los cruces; POST agrega uno ({leagueId, homeTeamId, awayTeamId, fase, horario: "AAAA-MM-DDTHH:mm"
// en hora argentina, venue?}); PATCH corrige horario y/o fase ({id, horario?, fase?}) de un cruce manual.
// Límite de tasa: como el resto de /api/admin, solo cuentan los fallos de Bearer (admin_fail en verificarAdmin).
const headers = { "Cache-Control": "no-store" };
const OPCIONES = { origin: "none", contentType: "json", rateLimit: [] } as const;

async function leerJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const datos = await request.json();
    return datos && typeof datos === "object" && !Array.isArray(datos) ? (datos as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function responder(resultado: Resultado, okStatus: number): Response {
  if (!resultado.ok) return Response.json({ error: resultado.error }, { status: resultado.status, headers });
  return Response.json({ partido: resultado.partido }, { status: okStatus, headers });
}

export const GET: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;
  return Response.json({ partidos: await listarCruces(createDb(env.DB)) }, { headers });
}, { rateLimit: [] });

export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;
  const datos = await leerJson(request);
  if (!datos) return Response.json({ error: "json_invalido" }, { status: 400, headers });

  const resultado = await agregarCruce(createDb(env.DB), datos);
  if (resultado.ok) locals.logger?.info("prode_cruce_agregado", { matchId: resultado.partido.id, fase: resultado.partido.fase });
  else locals.logger?.warn("prode_cruce_rechazado", { error: resultado.error });
  return responder(resultado, 201);
}, OPCIONES);

export const PATCH: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;
  const datos = await leerJson(request);
  if (!datos) return Response.json({ error: "json_invalido" }, { status: 400, headers });

  const resultado = await corregirPartido(createDb(env.DB), datos);
  if (resultado.ok) locals.logger?.info("prode_cruce_corregido", { matchId: resultado.partido.id, fase: resultado.partido.fase, horario: resultado.partido.horario.iso });
  else locals.logger?.warn("prode_cruce_rechazado", { error: resultado.error });
  return responder(resultado, 200);
}, OPCIONES);
