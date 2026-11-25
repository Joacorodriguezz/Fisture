import type { APIRoute } from "astro";
import { createDb } from "../../../../lib/db";
import { verificarAdmin } from "../../../../lib/observability/admin-auth";
import { withApi, type WithApiOptions } from "../../../../lib/observability/with-api";
import { agregarCruce, corregirPartido, listarCruces, type Resultado } from "../../../../lib/prode/partidos";
import { resultadoAutoHabilitado } from "../../../../lib/prode/puntos";

// Cruces del prode de playoffs, carga manual (Bearer ADMIN_SECRET).
// GET lista los cruces; POST agrega uno ({leagueId, homeTeamId, awayTeamId, fase, horario: "AAAA-MM-DDTHH:mm"
// en hora argentina, venue?}); PATCH corrige un cruce manual ({id, horario?, fase?, status?, homeScore?,
// awayScore?}). Goles enteros 0-20 a los 90' más adicionado, solo y siempre con status "finished"; otro
// estado los borra; "finished" antes del horario de inicio da 409 partido_no_empezado. Horario y fase no se cambian si el partido ya empezó (409); estado y resultado sí.
// Duplicados: POST y el PATCH de horario responden 409 {error: "cruce_duplicado", existente: {id, source}} si ya hay
// un partido de la misma liga, mismo local y visitante, de cualquier source (manual o espn), a menos de 6 h. Si el
// existente es de ESPN ("espn"), ese es el partido a usar: se suma con POST {adoptar: "<matchId>", fase} (201
// {partido}; 404 partido_inexistente; 409 ya_en_prode). Un adoptado no se edita acá (409 partido_no_manual): lo
// gobierna el sync. Equipos invertidos o con más de 6 h de diferencia (ida y vuelta) no cuentan como duplicado.
// Resultado a los 90' de un adoptado: PATCH {id, homeGoals90, awayGoals90} (enteros 0-20, solos) lo guarda en el
// vínculo sin tocar matches; 409 partido_no_empezado antes del horario, 409 partido_manual en un manual (ahí va
// {status: "finished", homeScore, awayScore}), 404 partido_inexistente fuera del prode. Sin él, un adoptado no puntúa.
// Quién pasó (docs/40 R3): {id, pasa: "home" | "away" | null}, solo o junto con homeGoals90/awayGoals90, en manuales y
// adoptados. Vale con empate a 90' (con ganador se deriva): un pasa que lo contradice da 409 pasa_inconsistente; sin
// pasa un empate terminado no puntúa para nadie. Adoptar ({adoptar}) un partido de ida o vuelta da 409 partido_con_vuelta.
// GET lista los partidos del prode (vínculo prode_matches): manuales y adoptados.
// Límite de tasa: como el resto de /api/admin, solo cuentan los fallos de Bearer (admin_fail en verificarAdmin).
const headers = { "Cache-Control": "no-store" };
const OPCIONES: WithApiOptions = { origin: "none", contentType: "json", rateLimit: [] };

async function leerJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const datos = await request.json();
    return datos && typeof datos === "object" && !Array.isArray(datos) ? (datos as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function responder(resultado: Resultado, okStatus: number): Response {
  if (!resultado.ok) {
    const cuerpo = resultado.existente ? { error: resultado.error, existente: resultado.existente } : { error: resultado.error };
    return Response.json(cuerpo, { status: resultado.status, headers });
  }
  return Response.json({ partido: resultado.partido }, { status: okStatus, headers });
}

export const GET: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;
  return Response.json({ partidos: await listarCruces(createDb(env.DB), resultadoAutoHabilitado(env)) }, { headers });
}, { rateLimit: [] });

export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;
  const datos = await leerJson(request);
  if (!datos) return Response.json({ error: "json_invalido" }, { status: 400, headers });

  const resultado = await agregarCruce(createDb(env.DB), datos, resultadoAutoHabilitado(env));
  if (resultado.ok) locals.logger?.info("prode_cruce_agregado", { matchId: resultado.partido.id, fase: resultado.partido.fase });
  else locals.logger?.warn("prode_cruce_rechazado", { error: resultado.error, existenteId: resultado.existente?.id, existenteSource: resultado.existente?.source, ...(resultado.existente?.source === "espn" ? { nota: "usar el partido de ESPN existente" } : {}) });
  return responder(resultado, 201);
}, OPCIONES);

export const PATCH: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;
  const rechazo = await verificarAdmin(request, env, { logger: locals.logger, requestId: locals.requestId });
  if (rechazo) return rechazo;
  const datos = await leerJson(request);
  if (!datos) return Response.json({ error: "json_invalido" }, { status: 400, headers });

  const resultado = await corregirPartido(createDb(env.DB), datos, resultadoAutoHabilitado(env));
  if (resultado.ok) locals.logger?.info("prode_cruce_corregido", { matchId: resultado.partido.id, fase: resultado.partido.fase, horario: resultado.partido.horario.iso, estado: resultado.partido.estado });
  else locals.logger?.warn("prode_cruce_rechazado", { error: resultado.error, existenteId: resultado.existente?.id, existenteSource: resultado.existente?.source, ...(resultado.existente?.source === "espn" ? { nota: "usar el partido de ESPN existente" } : {}) });
  return responder(resultado, 200);
}, OPCIONES);
