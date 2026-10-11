import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { matches, teams, leagues, userTeams } from "../../../../drizzle/schema";
import { eq, and, gte, or, inArray } from "drizzle-orm";
import { generateICS, type CalendarEvent } from "../../../lib/calendar/ics";
import { getPreferences, reminderMinutes } from "../../../lib/db/preferences";

export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user;
  if (!user) {
    return new Response("Unauthorized", { status: 401 });
  }

  const matchId = url.searchParams.get("matchId");
  const teamId = url.searchParams.get("teamId");
  const all = url.searchParams.get("all") === "true";

  const db = createDb(locals.runtime.env.DB);
  const events: CalendarEvent[] = [];

  if (matchId) {
    // Descargar un solo partido
    const matchData = await db
      .select({
        match: matches,
        homeTeam: teams,
        league: leagues,
      })
      .from(matches)
      .innerJoin(teams, eq(matches.homeTeamId, teams.id))
      .innerJoin(leagues, eq(matches.leagueId, leagues.id))
      .where(eq(matches.id, matchId))
      .limit(1);

    if (matchData.length === 0) {
      return new Response("Match not found", { status: 404 });
    }

    const { match, homeTeam, league } = matchData[0];
    const awayTeam = await db.query.teams.findFirst({
      where: eq(teams.id, match.awayTeamId),
    });

    if (!awayTeam) {
      return new Response("Away team not found", { status: 404 });
    }

    const startTime = new Date(match.dateTime);
    const endTime = new Date(startTime);
    endTime.setHours(endTime.getHours() + 2);

    events.push({
      id: match.id,
      title: `${homeTeam.name} vs ${awayTeam.name}`,
      description: `${league.name}\n\nGenerado con FISTURE`,
      location: match.venue || undefined,
      startTime,
      endTime,
    });
  } else if (teamId) {
    // Descargar todos los partidos de un equipo
    const teamMatches = await db
      .select({
        match: matches,
        homeTeam: teams,
        league: leagues,
      })
      .from(matches)
      .innerJoin(teams, eq(matches.homeTeamId, teams.id))
      .innerJoin(leagues, eq(matches.leagueId, leagues.id))
      .where(
        and(
          or(eq(matches.homeTeamId, teamId), eq(matches.awayTeamId, teamId)),
          gte(matches.dateTime, new Date())
        )
      );

    for (const { match, homeTeam, league } of teamMatches) {
      const awayTeam = await db.query.teams.findFirst({
        where: eq(teams.id, match.awayTeamId),
      });

      if (!awayTeam) continue;

      const startTime = new Date(match.dateTime);
      const endTime = new Date(startTime);
      endTime.setHours(endTime.getHours() + 2);

      events.push({
        id: match.id,
        title: `${homeTeam.name} vs ${awayTeam.name}`,
        description: `${league.name}\n\nGenerado con FISTURE`,
        location: match.venue || undefined,
        startTime,
        endTime,
      });
    }
  } else if (all) {
    // Descargar todos los partidos de equipos favoritos
    const myTeamIds = await db
      .select({ teamId: userTeams.teamId })
      .from(userTeams)
      .where(eq(userTeams.userId, user.id));

    if (myTeamIds.length === 0) {
      return new Response("No teams followed", { status: 404 });
    }

    const teamIdList = myTeamIds.map((t) => t.teamId);

    const allMatches = await db
      .select({
        match: matches,
        homeTeam: teams,
        league: leagues,
      })
      .from(matches)
      .innerJoin(teams, eq(matches.homeTeamId, teams.id))
      .innerJoin(leagues, eq(matches.leagueId, leagues.id))
      .where(
        and(
          or(
            inArray(matches.homeTeamId, teamIdList),
            inArray(matches.awayTeamId, teamIdList)
          ),
          gte(matches.dateTime, new Date())
        )
      );

    for (const { match, homeTeam, league } of allMatches) {
      const awayTeam = await db.query.teams.findFirst({
        where: eq(teams.id, match.awayTeamId),
      });

      if (!awayTeam) continue;

      const startTime = new Date(match.dateTime);
      const endTime = new Date(startTime);
      endTime.setHours(endTime.getHours() + 2);

      events.push({
        id: match.id,
        title: `${homeTeam.name} vs ${awayTeam.name}`,
        description: `${league.name}\n\nGenerado con FISTURE`,
        location: match.venue || undefined,
        startTime,
        endTime,
      });
    }
  } else {
    return new Response("matchId, teamId, or all=true required", { status: 400 });
  }

  if (events.length === 0) {
    return new Response("No events to download", { status: 404 });
  }

  const prefs = await getPreferences(db, user.id);
  const icsContent = generateICS(events, { reminderMinutes: reminderMinutes(prefs) });
  const filename = matchId
    ? `partido-${matchId}.ics`
    : teamId
    ? `equipo-${teamId}.ics`
    : "todos-los-partidos.ics";

  return new Response(icsContent, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
