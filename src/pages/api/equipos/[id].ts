import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { userTeams } from "../../../../drizzle/schema";
import { eq, and } from "drizzle-orm";

export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { id: teamId } = params;
  if (!teamId) {
    return new Response(JSON.stringify({ error: "Team ID is required" }), {
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

  if (existing.length === 0) {
    return new Response(JSON.stringify({ error: "Not following this team" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  await db
    .delete(userTeams)
    .where(and(eq(userTeams.userId, user.id), eq(userTeams.teamId, teamId)));

  return new Response(JSON.stringify({ success: true }), {
    headers: { "Content-Type": "application/json" },
  });
};

export const PATCH: APIRoute = async ({ params, request, locals }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { id: teamId } = params;
  if (!teamId) {
    return new Response(JSON.stringify({ error: "Team ID is required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await request.json();
  const { autoSync } = body;

  const db = createDb(locals.runtime.env.DB);

  const [updated] = await db
    .update(userTeams)
    .set({ autoSync })
    .where(and(eq(userTeams.userId, user.id), eq(userTeams.teamId, teamId)))
    .returning();

  if (!updated) {
    return new Response(JSON.stringify({ error: "Not following this team" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(JSON.stringify(updated), {
    headers: { "Content-Type": "application/json" },
  });
};
