import type { APIRoute } from "astro";
import { createDb } from "../../../../../lib/db";
import { esFase } from "../../../../../lib/prode/horario";
import { rankingProde, recortarRanking } from "../../../../../lib/prode/ranking";
import { resultadoAutoHabilitado } from "../../../../../lib/prode/puntos";
import { withApi } from "../../../../../lib/observability/with-api";

// Ranking de un grupo privado (acumulado o ?fase=). Solo para integrantes: un grupo ajeno o
// inexistente da el mismo 404 que el detalle. La pertenencia sale del propio ranking (los
// integrantes figuran aunque estén en 0), sin una consulta extra.
const headers = { "Cache-Control": "no-store" };
const noEncontrado = () => Response.json({ error: "Not found" }, { status: 404, headers });

export const GET: APIRoute = withApi(async ({ params, url, locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });

  const fase = url.searchParams.get("fase") ?? undefined;
  if (fase !== undefined && !esFase(fase)) return Response.json({ error: "fase_invalida" }, { status: 400, headers });
  if (!params.id) return noEncontrado();

  const filas = await rankingProde(createDb(locals.runtime.env.DB), { grupoId: params.id, fase, vos: user.id }, resultadoAutoHabilitado(locals.runtime.env));
  if (!filas.some((f) => f.esVos)) return noEncontrado();
  locals.logger?.info("prode_ranking", { alcance: "grupo", fase: fase ?? null, total: filas.length });
  return Response.json(recortarRanking(filas, fase), { headers });
}, { rateLimit: ["prode_lectura"] });
