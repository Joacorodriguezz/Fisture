import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { withApi } from "../../../lib/observability/with-api";
import { esFase } from "../../../lib/prode/horario";
import { puntosPorUsuario } from "../../../lib/prode/puntos";

// Puntos del prode del usuario con sesión: totales (puntos, exactos, aciertos, pasa) y el detalle por
// partido con resultado confirmado. Solo los propios. ?fase=octavos|cuartos|semifinal|final filtra.
const headers = { "Cache-Control": "no-store" };

export const GET: APIRoute = withApi(async ({ url, locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401, headers });

  const fase = url.searchParams.get("fase");
  if (fase !== null && !esFase(fase)) return Response.json({ error: "fase_invalida" }, { status: 400, headers });

  const { partidos, usuarios } = await puntosPorUsuario(createDb(locals.runtime.env.DB), { userId: user.id, fase: fase ?? undefined });
  const { puntos, exactos, aciertos, pasa } = usuarios[0];
  return Response.json(
    { puntos, exactos, aciertos, pasa, partidos: partidos.map(({ matchId, fase, puntos, marcador, extra, exacto, acierto }) => ({ matchId, fase, puntos, marcador, extra, exacto, acierto })) },
    { headers }
  );
}, { rateLimit: ["prode_lectura"] });
