// Historial de ejecuciones del sync (tabla sync_runs). Alimenta /api/health y /api/admin/status.
import { desc, lt, eq } from "drizzle-orm";
import type { Database } from "../db";
import { syncRuns } from "../../../drizzle/schema";
import type { SyncResult } from "../data-providers/sync";
import type { ConsistencyIssue, SyncRunStatus, SyncTrigger } from "./types";

export const RETENTION_DAYS = 30;
const MAX_ERRORES_POR_COMPETENCIA = 10;
const MAX_LARGO_ERROR = 500;

export interface ParsedSyncRun {
  id: string;
  trigger: SyncTrigger;
  startedAt: number;
  finishedAt: number | null;
  status: SyncRunStatus;
  durationMs: number | null;
  results: SyncResult[];
  issues: ConsistencyIssue[];
  error: string | null;
}

const truncar = (s: string) => (s.length > MAX_LARGO_ERROR ? s.slice(0, MAX_LARGO_ERROR) : s);

export function computeRunStatus(results: SyncResult[], issues: ConsistencyIssue[]): Exclude<SyncRunStatus, "running"> {
  const conErrores = results.filter((r) => r.errors.length > 0).length;
  if (results.length > 0 && conErrores === results.length) return "failed";
  if (conErrores > 0) return "partial";
  if (issues.some((i) => i.severity === "error")) return "partial";
  return "success";
}

export async function startSyncRun(db: Database, trigger: SyncTrigger, now = Date.now()): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(syncRuns).values({ id, trigger, startedAt: now, status: "running" });
  // Retención: sin job aparte, se limpia al iniciar cada run
  await db.delete(syncRuns).where(lt(syncRuns.startedAt, now - RETENTION_DAYS * 24 * 3_600_000));
  return id;
}

export async function finishSyncRun(
  db: Database,
  id: string,
  data: { results: SyncResult[]; issues: ConsistencyIssue[] },
  now = Date.now()
): Promise<Exclude<SyncRunStatus, "running">> {
  const status = computeRunStatus(data.results, data.issues);
  const acotados = data.results.map((r) => ({
    ...r,
    errors: r.errors.slice(0, MAX_ERRORES_POR_COMPETENCIA).map(truncar),
  }));
  const [run] = await db.select({ startedAt: syncRuns.startedAt }).from(syncRuns).where(eq(syncRuns.id, id));
  await db
    .update(syncRuns)
    .set({
      status,
      finishedAt: now,
      durationMs: run ? now - run.startedAt : null,
      results: JSON.stringify(acotados),
      issues: JSON.stringify(data.issues),
    })
    .where(eq(syncRuns.id, id));
  return status;
}

export async function failSyncRun(db: Database, id: string, error: unknown, now = Date.now()): Promise<void> {
  const mensaje = truncar(error instanceof Error ? error.message : String(error));
  const [run] = await db.select({ startedAt: syncRuns.startedAt }).from(syncRuns).where(eq(syncRuns.id, id));
  await db
    .update(syncRuns)
    .set({ status: "failed", finishedAt: now, durationMs: run ? now - run.startedAt : null, error: mensaje })
    .where(eq(syncRuns.id, id));
}

export async function getLatestRuns(db: Database, limit = 20): Promise<ParsedSyncRun[]> {
  const rows = await db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(limit);
  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger as SyncTrigger,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    status: r.status as SyncRunStatus,
    durationMs: r.durationMs,
    results: JSON.parse(r.results),
    issues: JSON.parse(r.issues),
    error: r.error,
  }));
}
