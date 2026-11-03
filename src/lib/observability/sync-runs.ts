// Historial de ejecuciones del sync (tabla sync_runs). Alimenta /api/health y /api/admin/status.
import { and, desc, lt, eq } from "drizzle-orm";
import type { Database } from "../db";
import { syncRuns } from "../../../drizzle/schema";
import type { SyncResult } from "../data-providers/sync";
import type { ConsistencyIssue, SyncKind, SyncRunStatus, SyncTrigger } from "./types";
import { mensajeDeError } from "./logger";

export const RETENTION_DAYS = 30;
const MAX_ERRORES_POR_COMPETENCIA = 10;
const MAX_LARGO_ERROR = 500;

export interface ParsedSyncRun {
  id: string;
  trigger: SyncTrigger;
  kind: SyncKind;
  startedAt: number;
  finishedAt: number | null;
  status: SyncRunStatus;
  durationMs: number | null;
  // En los runs de calendarios es un solo elemento: ResumenCalendarios
  results: SyncResult[];
  issues: ConsistencyIssue[];
  error: string | null;
}

// Resumen de un lote de reconciliación de calendarios (solo conteos, sin ids ni correos)
export interface ResumenCalendarios {
  usuarios: number;
  eventosOk: number;
  eventosFallidos: number;
  // Usuarios que perdieron el acceso a su calendario en este lote (docs/17 B4)
  sinAcceso: number;
  cortadoPorPresupuesto: boolean;
  // Quedan usuarios por atender en este barrido
  quedan: boolean;
  // Consultas D1 y llamadas al calendario gastadas (tope: 50 en Workers Free)
  subrequests: number;
}

const truncar = (s: string) => (s.length > MAX_LARGO_ERROR ? s.slice(0, MAX_LARGO_ERROR) : s);

export function computeRunStatus(results: SyncResult[], issues: ConsistencyIssue[]): Exclude<SyncRunStatus, "running"> {
  const conErrores = results.filter((r) => r.errors.length > 0).length;
  if (results.length > 0 && conErrores === results.length) return "failed";
  if (conErrores > 0) return "partial";
  if (issues.some((i) => i.severity === "error")) return "partial";
  return "success";
}

async function purgarViejos(db: Database, now: number): Promise<void> {
  // Retención: sin job aparte, se limpia al registrar cada run
  await db.delete(syncRuns).where(lt(syncRuns.startedAt, now - RETENTION_DAYS * 24 * 3_600_000));
}

export async function startSyncRun(db: Database, trigger: SyncTrigger, now = Date.now()): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(syncRuns).values({ id, trigger, startedAt: now, status: "running" });
  await purgarViejos(db, now);
  return id;
}

// Cada lote de calendarios cuenta contra las 50 subrequests de la invocación: se registra de una vez,
// ya terminado (un INSERT y la purga), en lugar de iniciar y cerrar el run (4 consultas).
export async function registrarRunCalendarios(
  db: Database,
  data: {
    trigger: SyncTrigger;
    startedAt: number;
    finishedAt: number;
    status: Exclude<SyncRunStatus, "running">;
    resumen: ResumenCalendarios;
    error?: unknown;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(syncRuns).values({
    id,
    trigger: data.trigger,
    kind: "calendars",
    startedAt: data.startedAt,
    finishedAt: data.finishedAt,
    durationMs: data.finishedAt - data.startedAt,
    status: data.status,
    results: JSON.stringify([data.resumen]),
    error: data.error === undefined ? null : truncar(mensajeDeError(data.error)),
  });
  await purgarViejos(db, data.startedAt);
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
  const mensaje = truncar(mensajeDeError(error));
  const [run] = await db.select({ startedAt: syncRuns.startedAt }).from(syncRuns).where(eq(syncRuns.id, id));
  await db
    .update(syncRuns)
    .set({ status: "failed", finishedAt: now, durationMs: run ? now - run.startedAt : null, error: mensaje })
    .where(eq(syncRuns.id, id));
}

export async function getLatestRuns(db: Database, limit = 20, kind?: SyncKind): Promise<ParsedSyncRun[]> {
  const rows = await db
    .select()
    .from(syncRuns)
    .where(kind ? eq(syncRuns.kind, kind) : undefined)
    .orderBy(desc(syncRuns.startedAt))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    trigger: r.trigger as SyncTrigger,
    kind: r.kind as SyncKind,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    status: r.status as SyncRunStatus,
    durationMs: r.durationMs,
    results: JSON.parse(r.results),
    issues: JSON.parse(r.issues),
    error: r.error,
  }));
}

export async function getLastSuccessAt(db: Database, kind: SyncKind = "leagues"): Promise<number | null> {
  const [row] = await db
    .select({ finishedAt: syncRuns.finishedAt })
    .from(syncRuns)
    .where(and(eq(syncRuns.status, "success"), eq(syncRuns.kind, kind)))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);
  return row?.finishedAt ?? null;
}
