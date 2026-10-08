import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { matches, teams, leagues, calendarSyncs, users } from "../../../../drizzle/schema";
import { eq } from "drizzle-orm";
import {
  createGoogleCalendarEvent,
  formatMatchForGoogle,
} from "../../../lib/calendar/google";
import {
  createMicrosoftCalendarEvent,
  formatMatchForMicrosoft,
} from "../../../lib/calendar/microsoft";

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user;
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const body = await request.json();
  const { matchId, matchIds } = body;

  // Soporte para sync individual o múltiple
  const idsToSync: string[] = matchIds || (matchId ? [matchId] : []);

  if (idsToSync.length === 0) {
    return new Response(JSON.stringify({ error: "matchId or matchIds required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const db = createDb(locals.runtime.env.DB);
  const results: { matchId: string; success: boolean; error?: string }[] = [];

  // Obtener access token actualizado del usuario
  const dbUser = await db.query.users.findFirst({
    where: eq(users.id, user.id),
  });

  if (!dbUser?.accessToken) {
    return new Response(JSON.stringify({ error: "No calendar access token" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  for (const id of idsToSync) {
    try {
      // Obtener datos del partido
      const matchData = await db
        .select({
          match: matches,
          homeTeam: teams,
          awayTeam: {
            id: teams.id,
            name: teams.name,
          },
          league: leagues,
        })
        .from(matches)
        .innerJoin(teams, eq(matches.homeTeamId, teams.id))
        .innerJoin(leagues, eq(matches.leagueId, leagues.id))
        .where(eq(matches.id, id))
        .limit(1);

      if (matchData.length === 0) {
        results.push({ matchId: id, success: false, error: "Match not found" });
        continue;
      }

      const { match, homeTeam, league } = matchData[0];

      // Obtener away team por separado
      const awayTeam = await db.query.teams.findFirst({
        where: eq(teams.id, match.awayTeamId),
      });

      if (!awayTeam) {
        results.push({ matchId: id, success: false, error: "Away team not found" });
        continue;
      }

      // Verificar si ya está sincronizado
      const existingSync = await db.query.calendarSyncs.findFirst({
        where: eq(calendarSyncs.matchId, id),
      });

      if (existingSync?.status === "synced") {
        results.push({ matchId: id, success: true });
        continue;
      }

      let externalEventId: string;

      // Crear evento en el calendario según el provider
      if (user.provider === "google") {
        const event = formatMatchForGoogle(
          homeTeam.name,
          awayTeam.name,
          league.name,
          new Date(match.dateTime),
          match.venue
        );

        const response = await createGoogleCalendarEvent(dbUser.accessToken, event);
        externalEventId = response.id;
      } else if (user.provider === "microsoft") {
        const event = formatMatchForMicrosoft(
          homeTeam.name,
          awayTeam.name,
          league.name,
          new Date(match.dateTime),
          match.venue
        );

        const response = await createMicrosoftCalendarEvent(dbUser.accessToken, event);
        externalEventId = response.id;
      } else {
        results.push({ matchId: id, success: false, error: "Unsupported provider" });
        continue;
      }

      // Guardar en DB
      if (existingSync) {
        await db
          .update(calendarSyncs)
          .set({
            externalEventId,
            status: "synced",
            lastSyncedAt: new Date(),
            errorMessage: null,
          })
          .where(eq(calendarSyncs.id, existingSync.id));
      } else {
        await db.insert(calendarSyncs).values({
          userId: user.id,
          matchId: id,
          provider: user.provider,
          externalEventId,
          status: "synced",
          lastSyncedAt: new Date(),
        });
      }

      results.push({ matchId: id, success: true });
    } catch (error) {
      console.error(`Sync error for match ${id}:`, error);
      results.push({
        matchId: id,
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  const allSuccess = results.every((r) => r.success);

  return new Response(JSON.stringify({ success: allSuccess, results }), {
    status: allSuccess ? 200 : 207,
    headers: { "Content-Type": "application/json" },
  });
};
