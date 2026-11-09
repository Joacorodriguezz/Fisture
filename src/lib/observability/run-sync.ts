// Ejecuta el sync de competencias dejando registro: historial en sync_runs, logs estructurados
// y chequeos de consistencia. Lo usa POST /api/admin/sync (el workflow sync-cron.yml, docs/22 D4).
import { createDb } from "../db";
import { syncAllLeagues, syncLote, syncSingleLeague, type LoteResult, type SyncEnv, type SyncResult } from "../data-providers/sync";
import { purgeExpiredSessions } from "../auth/session";
import { limpiarRateLimits } from "../rate-limit/cleanup";
import { checkConsistency } from "./consistency";
import { mensajeDeError, rootLogger, type Logger } from "./logger";
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
  // Opcional para no obligar a los tests existentes a declararlo
  syncLote?: (env: SyncEnv, lote: number) => Promise<LoteResult>;
}

const depsReales: RunSyncDeps = {
  syncAllLeagues,
  syncSingleLeague,
  syncLote,
};

export interface RunSyncOptions {
  // Sincronizar solo una competencia (slug de ESPN)
  leagueId?: string;
  // Sincronizar solo un lote de competencias (docs/22 D4)
  lote?: number;
  logger?: Logger;
  deps?: RunSyncDeps;
}

export interface RunSyncOutcome {
  runId: string;
  status: Exclude<SyncRunStatus, "running">;
  results: SyncResult[];
  issues: ConsistencyIssue[];
  error?: string;
  // Solo al sincronizar por lotes
  lote?: Omit<LoteResult, "results">;
}

export async function runSync(env: RunSyncEnv, trigger: SyncTrigger, options: RunSyncOptions = {}): Promise<RunSyncOutcome> {
  const deps = options.deps ?? depsReales;
  const db = createDb(env.DB);
  const runId = await startSyncRun(db, trigger);
  const logger = (options.logger ?? rootLogger).child({ runId, trigger });
  logger.info("sync_started", { leagueId: options.leagueId, lote: options.lote });

  try {
    let lote: RunSyncOutcome["lote"];
    let results: SyncResult[];
    if (options.leagueId) {
      results = [await deps.syncSingleLeague(env, options.leagueId)];
    } else if (options.lote !== undefined) {
      const { results: delLote, ...info } = await (deps.syncLote ?? syncLote)(env, options.lote);
      results = delLote;
      lote = info;
    } else {
      results = await deps.syncAllLeagues(env);
    }

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

    // Los chequeos miran la base entera: en un barrido por lotes corren solo al cerrarlo (docs/30 D1)
    if (lote && lote.siguienteLote !== null) {
      logger.info("consistency_skipped", { lote: lote.lote, siguienteLote: lote.siguienteLote });
    } else {
      try {
        issues.push(...(await checkConsistency(db)));
      } catch (err) {
        logger.error("consistency_check_failed", { err });
        issues.push({ code: "consistency_check_failed", severity: "error", count: 1, sample: [] });
      }
    }
    for (const issue of issues) {
      const nivel = issue.severity === "error" ? "error" : "warn";
      logger[nivel]("consistency_issue", { ...issue });
    }

    // Higiene: las sesiones vencidas ya no autentican (docs/21 D6). Solo conteos en el log, nunca ids.
    try {
      logger.info("sessions_purged", { count: await purgeExpiredSessions(db) });
    } catch (err) {
      logger.warn("sessions_purge_failed", { err });
    }

    // Higiene: contadores del límite de tasa de más de 24 h (docs/16 §4 D1). Un fallo no afecta al sync.
    try {
      logger.info("rate_limits_purged", { count: await limpiarRateLimits(env.DB) });
    } catch (err) {
      logger.warn("rate_limits_purge_failed", { err });
    }

    try {
      await env.KV?.delete(MATCHES_CACHE_KEY);
    } catch (err) {
      logger.warn("cache_invalidation_failed", { err });
    }

    const status = await finishSyncRun(db, runId, { results, issues });
    logger.info("sync_finished", { status, leagues: results.length, issueCount: issues.length });
    return { runId, status, results, issues, ...(lote ? { lote } : {}) };
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
      error: mensajeDeError(err),
    };
  }
}
