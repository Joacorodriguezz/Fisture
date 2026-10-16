// Mismo servicio que usa /api/admin/sync (ESPN + chequeos de consistencia), más el sync de calendarios.
// Cada ejecución queda registrada en la tabla sync_runs.
import { runSync } from "../src/lib/observability/run-sync";
import { createLogger, defaultLevel } from "../src/lib/observability/logger";

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
    const logger = createLogger({ level: defaultLevel(env.ENVIRONMENT), env: env.ENVIRONMENT }).child({
      cron: event.cron,
    });

    try {
      await runSync(env, "cron", { calendarAutoSync: true, logger });
    } catch (error) {
      // Solo llega acá si ni siquiera se pudo registrar el run (p. ej. D1 caída)
      logger.error("cron_failed", { err: error });
    }
  },
};
