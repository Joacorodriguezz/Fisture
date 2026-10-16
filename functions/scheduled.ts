// Mismo servicio que usa /api/admin/sync (football-data.org + Promiedos)
import { syncAllLeagues } from "../src/lib/data-providers/sync";
import { createDb } from "../src/lib/db";
import { runCalendarAutoSync } from "../src/lib/calendar/sync-service";

interface ScheduledEvent {
  cron: string;
  type: string;
  scheduledTime: number;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export default {
  async scheduled(
    event: ScheduledEvent,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    console.log(`[CRON] Starting sync at ${new Date().toISOString()}`);
    console.log(`[CRON] Triggered by: ${event.cron}`);

    try {
      const results = await syncAllLeagues(env);

      // Log resultados
      let totalMatches = 0;
      let totalErrors = 0;

      for (const result of results) {
        console.log(`[CRON] ${result.league}:`, {
          teams: `${result.teamsCreated} created`,
          matches: `${result.matchesCreated} created, ${result.matchesUpdated} updated`,
          errors: result.errors.length,
        });

        totalMatches += result.matchesCreated + result.matchesUpdated;
        totalErrors += result.errors.length;
      }

      // Llevar los calendarios de los usuarios al día con el fixture nuevo
      await runCalendarAutoSync(env, createDb(env.DB));

      // Invalidar cache de partidos en KV
      await env.KV.delete("cache:matches:all");

      console.log(`[CRON] Sync completed at ${new Date().toISOString()}`);
      console.log(`[CRON] Summary: ${totalMatches} matches synced, ${totalErrors} errors`);
    } catch (error) {
      console.error(`[CRON] Sync failed:`, error);
    }
  },
};
