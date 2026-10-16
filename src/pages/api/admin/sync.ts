import type { APIRoute } from "astro";
import { syncAllLeagues, syncSingleLeague } from "../../../lib/data-providers/sync";
import { withApi } from "../../../lib/observability/with-api";

export const POST: APIRoute = withApi(async ({ request, locals }) => {
  const env = locals.runtime.env;

  // Verificar admin secret
  const authHeader = request.headers.get("Authorization");
  const adminSecret = env.ADMIN_SECRET;

  if (!adminSecret || authHeader !== `Bearer ${adminSecret}`) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    // Opcional: sincronizar solo una liga específica
    const body = await request.json().catch(() => ({}));
    const leagueId = body.leagueId as string | undefined;

    console.log(`[ADMIN SYNC] Starting sync at ${new Date().toISOString()}`);

    let results;
    if (leagueId) {
      console.log(`[ADMIN SYNC] Syncing single league: ${leagueId}`);
      const result = await syncSingleLeague(env, leagueId);
      results = [result];
    } else {
      results = await syncAllLeagues(env);
    }

    // Log resultados
    for (const result of results) {
      console.log(`[ADMIN SYNC] ${result.league} (${result.source}):`, {
        teams: `${result.teamsCreated} created, ${result.teamsUpdated} updated`,
        matches: `${result.matchesCreated} created, ${result.matchesUpdated} updated`,
        errors: result.errors.length,
      });
    }

    // Invalidar cache de partidos en KV si existe
    if (env.KV) {
      await env.KV.delete("cache:matches:all");
    }

    console.log(`[ADMIN SYNC] Sync completed at ${new Date().toISOString()}`);

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[ADMIN SYNC] Sync failed:", error);

    return new Response(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
