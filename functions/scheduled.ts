import { syncAllLeagues } from "../src/lib/football-api/sync";

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

      // Invalidar cache de partidos en KV
      await env.KV.delete("cache:matches:all");

      console.log(`[CRON] Sync completed at ${new Date().toISOString()}`);
      console.log(`[CRON] Summary: ${totalMatches} matches synced, ${totalErrors} errors`);
    } catch (error) {
      console.error(`[CRON] Sync failed:`, error);
    }
  },
};
