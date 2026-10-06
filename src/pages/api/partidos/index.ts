import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { getUpcomingMatches } from "../../../lib/db/queries";
import { calendarSyncs } from "../../../../drizzle/schema";
import { eq, and, inArray } from "drizzle-orm";

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
  let syncMap = new Map<string, string>();

  if (matchIds.length > 0) {
    const syncs = await db
      .select()
      .from(calendarSyncs)
      .where(
        and(
          eq(calendarSyncs.userId, user.id),
          inArray(calendarSyncs.matchId, matchIds)
        )
      );

    syncMap = new Map(syncs.map((s) => [s.matchId, s.status || "pending"]));
  }

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
