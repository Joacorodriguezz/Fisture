import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { teams, leagues, userTeams } from "../../../../drizzle/schema";
import { like, eq, and } from "drizzle-orm";
import { withApi } from "../../../lib/observability/with-api";

export const GET: APIRoute = withApi(async ({ url, locals }) => {
  // Búsqueda pública: sin sesión devuelve isFollowing=false
  const user = locals.user;

  const query = url.searchParams.get("q")?.trim();
  if (!query || query.length < 2) {
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = createDb(locals.runtime.env.DB);

  const results = await db
    .select({
      id: teams.id,
      name: teams.name,
      logo: teams.logo,
      league: {
        id: leagues.id,
        name: leagues.name,
      },
    })
    .from(teams)
    .innerJoin(leagues, eq(teams.leagueId, leagues.id))
    .where(like(teams.name, `%${query}%`))
    .limit(20);

  const userTeamIds = user
    ? await db.select({ teamId: userTeams.teamId }).from(userTeams).where(eq(userTeams.userId, user.id))
    : [];

  const followingSet = new Set(userTeamIds.map((ut) => ut.teamId));

  const teamsWithFollowStatus = results.map((team) => ({
    ...team,
    isFollowing: followingSet.has(team.id),
  }));

  return new Response(JSON.stringify(teamsWithFollowStatus), {
    headers: { "Content-Type": "application/json" },
  });
});
