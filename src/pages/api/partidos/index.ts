import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { getUpcomingMatches, getSyncStates } from "../../../lib/db/queries";

export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const limit = parseInt(url.searchParams.get("limit") || "20");
  const teamId = url.searchParams.get("teamId");

  const db = createDb(locals.runtime.env.DB);
  let matchesData = await getUpcomingMatches(db, user.id, Math.min(limit, 100));

  // Filtrar por equipo si se especifica
  if (teamId) {
    matchesData = matchesData.filter(
      (m) => m.match.homeTeamId === teamId || m.match.awayTeamId === teamId
    );
  }

  // Obtener estado de sync para cada partido
  const matchIds = matchesData.map((m) => m.match.id);
  // getSyncStates parte los IDs en lotes (D1 admite máximo 100 parámetros por consulta)
  const estados = await getSyncStates(db, user.id, matchIds);
  const syncMap = new Map([...estados].map(([id, s]) => [id, s.status]));

  const response = matchesData.map((m) => ({
    id: m.match.id,
    dateTime: m.match.dateTime,
    venue: m.match.venue,
    round: m.match.round,
    status: m.match.status,
    homeScore: m.match.homeScore,
    awayScore: m.match.awayScore,
    homeTeam: {
      id: m.homeTeam.id,
      name: m.homeTeam.name,
      shortName: m.homeTeam.shortName,
      logo: m.homeTeam.logo,
    },
    awayTeam: {
      id: m.awayTeam.id,
      name: m.awayTeam.name,
      shortName: m.awayTeam.shortName,
      logo: m.awayTeam.logo,
    },
    league: {
      id: m.league.id,
      name: m.league.name,
      country: m.league.country,
    },
    syncStatus: syncMap.get(m.match.id) || null,
  }));

  return new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json" },
  });
};
