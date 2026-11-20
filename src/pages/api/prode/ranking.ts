import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { esFase } from "../../../lib/prode/horario";
import { rankingProde, recortarRanking } from "../../../lib/prode/ranking";
import { withApi } from "../../../lib/observability/with-api";

// Ranking general del prode (acumulado o ?fase=octavos|cuartos|semifinal|final). Requiere sesión.
// Hasta 100 filas; `yo` trae la fila propia aunque quede fuera (null si todavía no puntuó).
const headers = { "Cache-Control": "no-store" };

export const GET: APIRoute = withApi(async ({ url, locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });

  const fase = url.searchParams.get("fase") ?? undefined;
  if (fase !== undefined && !esFase(fase)) return Response.json({ error: "fase_invalida" }, { status: 400, headers });

  const filas = await rankingProde(createDb(locals.runtime.env.DB), { fase, vos: user.id });
  locals.logger?.info("prode_ranking", { alcance: "general", fase: fase ?? null, total: filas.length });
  return Response.json(recortarRanking(filas, fase), { headers });
}, { rateLimit: ["prode_lectura"] });
