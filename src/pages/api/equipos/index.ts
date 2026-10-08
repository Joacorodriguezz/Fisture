import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { userTeams, teams, leagues } from "../../../../drizzle/schema";
import { eq, desc, and } from "drizzle-orm";

export const GET: APIRoute = async ({ locals }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = createDb(locals.runtime.env.DB);

  const myTeams = await db
    .select({
      id: userTeams.id,
      teamId: teams.id,
      teamName: teams.name,
      teamLogo: teams.logo,
      leagueName: leagues.name,
      autoSync: userTeams.autoSync,
      createdAt: userTeams.createdAt,
    })
    .from(userTeams)
    .innerJoin(teams, eq(userTeams.teamId, teams.id))
    .innerJoin(leagues, eq(teams.leagueId, leagues.id))
    .where(eq(userTeams.userId, user.id))
    .orderBy(desc(userTeams.createdAt));

  return new Response(JSON.stringify(myTeams), {
    headers: { "Content-Type": "application/json" },
  });
};

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await request.json();
  const { teamId } = body;

  if (!teamId) {
    return new Response(JSON.stringify({ error: "teamId is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = createDb(locals.runtime.env.DB);

  const existing = await db
    .select()
    .from(userTeams)
    .where(and(eq(userTeams.userId, user.id), eq(userTeams.teamId, teamId)))
    .limit(1);

  if (existing.length > 0) {
    return new Response(JSON.stringify({ error: "Already following this team" }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  }

  const team = await db.select().from(teams).where(eq(teams.id, teamId)).limit(1);
  if (team.length === 0) {
    return new Response(JSON.stringify({ error: "Team not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const [newUserTeam] = await db
    .insert(userTeams)
    .values({
      userId: user.id,
      teamId,
      autoSync: true,
    })
    .returning();

  return new Response(JSON.stringify(newUserTeam), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
};
