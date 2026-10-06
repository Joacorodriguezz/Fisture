import type { APIRoute } from "astro";
import { syncAllLeagues } from "../../../lib/football-api/sync";

export const POST: APIRoute = async ({ request, locals }) => {
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
    console.log(`[ADMIN SYNC] Starting manual sync at ${new Date().toISOString()}`);

    const results = await syncAllLeagues(env);

    // Log resultados
    for (const result of results) {
      console.log(`[ADMIN SYNC] ${result.league}:`, {
        teams: `${result.teamsCreated} created`,
        matches: `${result.matchesCreated} created, ${result.matchesUpdated} updated`,
        errors: result.errors.length,
      });
    }

    // Invalidar cache de partidos en KV
    await env.KV.delete("cache:matches:all");

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
};
