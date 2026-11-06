import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { teams, leagues, leagueTeams, userTeams } from "../../../../drizzle/schema";
import { and, eq, inArray, like } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { withApi } from "../../../lib/observability/with-api";

const MAX_QUERY = 50;

export const GET: APIRoute = withApi(async ({ url, locals }) => {
  // Búsqueda pública: sin sesión devuelve isFollowing=false
  const user = locals.user;

  const query = url.searchParams.get("q")?.trim();
  // Tope de largo (docs/16 D4): ningún nombre de equipo se acerca, y evita LIKE con textos enormes
  if (!query || query.length < 2 || query.length > MAX_QUERY) {
    return new Response(JSON.stringify([]), {
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = createDb(locals.runtime.env.DB);

  // Solo equipos que juegan alguna competencia destacada: los rivales de las copas nacionales
  // (clubes amateurs de la FA Cup, por ejemplo) existen en la base pero no se ofrecen (docs/22)
  const destacada = alias(leagues, "destacada");
  const enDestacadas = db
    .select({ teamId: leagueTeams.teamId })
    .from(leagueTeams)
    .innerJoin(destacada, eq(leagueTeams.leagueId, destacada.id))
    .where(and(eq(destacada.isFeatured, true), eq(destacada.isActive, true)));

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
    .where(and(like(teams.name, `%${query}%`), inArray(teams.id, enDestacadas)))
    .limit(20);

  const userTeamIds = user
    ? await db.select({ teamId: userTeams.teamId }).from(userTeams).where(eq(userTeams.userId, user.id))
    : [];

  const followingSet = new Set(userTeamIds.map((ut) => ut.teamId));

  const teamsWithFollowStatus = results.map((team) => ({
    ...team,
    isFollowing: followingSet.has(team.id),
  }));

  // El resultado depende de la sesión (isFollowing): solo la respuesta anónima puede cachearse en común
  return new Response(JSON.stringify(teamsWithFollowStatus), {
    headers: { "Content-Type": "application/json", "Cache-Control": user ? "private, max-age=60" : "public, max-age=60" },
  });
}, { rateLimit: ["search_public"] });
