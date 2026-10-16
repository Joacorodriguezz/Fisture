// Ejecuta el sync de competencias dejando registro: historial en sync_runs, logs estructurados
// y chequeos de consistencia. Lo usan el cron (functions/scheduled.ts) y POST /api/admin/sync.
import { createDb } from "../db";
import { syncAllLeagues, syncSingleLeague, type SyncEnv, type SyncResult } from "../data-providers/sync";
import { runCalendarAutoSync } from "../calendar/sync-service";
import { checkConsistency } from "./consistency";
import { rootLogger, type Logger } from "./logger";
import { failSyncRun, finishSyncRun, startSyncRun } from "./sync-runs";
import type { ConsistencyIssue, SyncRunStatus, SyncTrigger } from "./types";

export const MATCHES_CACHE_KEY = "cache:matches:all";

export interface RunSyncEnv extends SyncEnv {
  KV?: { delete(key: string): Promise<void> };
}

// Dependencias inyectables (los tests reemplazan los proveedores reales)
export interface RunSyncDeps {
  syncAllLeagues: (env: SyncEnv) => Promise<SyncResult[]>;
  syncSingleLeague: (env: SyncEnv, leagueExternalId: string) => Promise<SyncResult>;
  calendarAutoSync: (env: RunSyncEnv, db: ReturnType<typeof createDb>) => Promise<void>;
}

const depsReales: RunSyncDeps = {
  syncAllLeagues,
  syncSingleLeague,
  calendarAutoSync: (env, db) => runCalendarAutoSync(env as unknown as Env, db),
};

export interface RunSyncOptions {
  // Sincronizar solo una competencia (slug de ESPN)
  leagueId?: string;
  // Llevar al día los calendarios de los usuarios (solo el cron)
  calendarAutoSync?: boolean;
  logger?: Logger;
  deps?: RunSyncDeps;
}

export interface RunSyncOutcome {
  runId: string;
  status: Exclude<SyncRunStatus, "running">;
  results: SyncResult[];
  issues: ConsistencyIssue[];
  error?: string;
}

export async function runSync(env: RunSyncEnv, trigger: SyncTrigger, options: RunSyncOptions = {}): Promise<RunSyncOutcome> {
  const deps = options.deps ?? depsReales;
  const db = createDb(env.DB);
  const runId = await startSyncRun(db, trigger);
  const logger = (options.logger ?? rootLogger).child({ runId, trigger });
  logger.info("sync_started", { leagueId: options.leagueId });

  try {
    const results = options.leagueId
      ? [await deps.syncSingleLeague(env, options.leagueId)]
      : await deps.syncAllLeagues(env);

    for (const r of results) {
      const campos = {
        league: r.league,
        source: r.source,
        teamsCreated: r.teamsCreated,
        teamsUpdated: r.teamsUpdated,
        matchesCreated: r.matchesCreated,
        matchesUpdated: r.matchesUpdated,
        matchesSkipped: r.matchesSkipped,
        errors: r.errors.slice(0, 5),
        errorCount: r.errors.length,
      };
      if (r.errors.length > 0) logger.warn("sync_league_errors", campos);
      else logger.info("sync_league", campos);
    }

    const issues: ConsistencyIssue[] = [];

    if (options.calendarAutoSync) {
      try {
        await deps.calendarAutoSync(env, db);
      } catch (err) {
        logger.error("calendar_autosync_failed", { err });
        issues.push({ code: "calendar_autosync_failed", severity: "error", count: 1, sample: [] });
      }
    }

    try {
      issues.push(...(await checkConsistency(db)));
    } catch (err) {
      logger.error("consistency_check_failed", { err });
      issues.push({ code: "consistency_check_failed", severity: "error", count: 1, sample: [] });
    }
    for (const issue of issues) {
      const nivel = issue.severity === "error" ? "error" : "warn";
      logger[nivel]("consistency_issue", { ...issue });
    }

    try {
      await env.KV?.delete(MATCHES_CACHE_KEY);
    } catch (err) {
      logger.warn("cache_invalidation_failed", { err });
    }

    const status = await finishSyncRun(db, runId, { results, issues });
    logger.info("sync_finished", { status, leagues: results.length, issueCount: issues.length });
    return { runId, status, results, issues };
  } catch (err) {
    logger.error("sync_failed", { err });
    try {
      await failSyncRun(db, runId, err);
    } catch (registroErr) {
      logger.error("sync_run_record_failed", { err: registroErr });
    }
    return {
      runId,
      status: "failed",
      results: [],
      issues: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
