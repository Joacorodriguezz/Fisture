// Estado de salud del sistema. Las reglas del sync son una función pura (evaluateSyncHealth).
import { createDb } from "../db";
import { getLastSuccessAt, getLatestRuns } from "./sync-runs";
import type { SyncRunStatus } from "./types";

export type CheckStatus = "ok" | "degraded" | "fail";

// Sync diario (24 h) + margen
export const SYNC_OK_MAX_AGE_MS = 26 * 3_600_000;
export const SYNC_DEGRADED_MAX_AGE_MS = 50 * 3_600_000;
// Un run "running" más viejo que esto se considera colgado (el Worker murió)
export const RUN_HUNG_AFTER_MS = 10 * 60_000;

export interface SyncHealthInput {
  latest: { status: SyncRunStatus; startedAt: number; finishedAt: number | null } | null;
  lastSuccessAt: number | null;
  now: number;
}

export function evaluateSyncHealth({ latest, lastSuccessAt, now }: SyncHealthInput): CheckStatus {
  // Sin runs: puede ser un cron que nunca corrió (p. ej. Pages no ejecuta Cron Triggers)
  if (!latest) return "fail";
  if (latest.status === "failed") return "fail";
  if (latest.status === "running" && now - latest.startedAt > RUN_HUNG_AFTER_MS) return "fail";

  if (latest.status === "partial") {
    const edad = now - (latest.finishedAt ?? latest.startedAt);
    return edad > SYNC_DEGRADED_MAX_AGE_MS ? "fail" : "degraded";
  }

  // success, o running reciente: se juzga por el último success
  if (lastSuccessAt === null) return "degraded";
  const edad = now - lastSuccessAt;
  if (edad <= SYNC_OK_MAX_AGE_MS) return "ok";
  if (edad <= SYNC_DEGRADED_MAX_AGE_MS) return "degraded";
  return "fail";
}

export function overallStatus(checks: Record<string, CheckStatus>): CheckStatus {
  const valores = Object.values(checks);
  if (valores.includes("fail")) return "fail";
  if (valores.includes("degraded")) return "degraded";
  return "ok";
}

export interface HealthEnv {
  DB: D1Database;
  KV?: { get(key: string): Promise<unknown> };
  OAUTH_STATE_SECRET?: string;
}

export interface Health {
  status: CheckStatus;
  checks: { db: CheckStatus; kv: CheckStatus; sync: CheckStatus; oauthState: CheckStatus };
  lastSyncAt: string | null;
}

export async function getHealth(env: HealthEnv, now = Date.now()): Promise<Health> {
  let db: CheckStatus = "ok";
  let kv: CheckStatus = "ok";
  let sync: CheckStatus = "fail";
  let lastSuccessAt: number | null = null;

  try {
    await env.DB.prepare("SELECT 1").first();
  } catch {
    db = "fail";
  }

  try {
    if (!env.KV) throw new Error("KV no configurado");
    await env.KV.get("health:ping");
  } catch {
    kv = "fail";
  }

  if (db === "ok") {
    try {
      const database = createDb(env.DB);
      const [latest] = await getLatestRuns(database, 1);
      lastSuccessAt = await getLastSuccessAt(database);
      sync = evaluateSyncHealth({ latest: latest ?? null, lastSuccessAt, now });
    } catch {
      sync = "fail";
    }
  }

  // Sin el secret el login falla cerrado (docs/20): se detecta acá antes de que lo note un usuario
  const oauthState: CheckStatus = env.OAUTH_STATE_SECRET ? "ok" : "fail";

  const checks = { db, kv, sync, oauthState };
  return {
    status: overallStatus(checks),
    checks,
    lastSyncAt: lastSuccessAt === null ? null : new Date(lastSuccessAt).toISOString(),
  };
}
