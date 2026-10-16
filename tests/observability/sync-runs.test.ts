import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/d1";
import { createDb, type Database } from "../../src/lib/db";
import {
  computeRunStatus,
  failSyncRun,
  finishSyncRun,
  getLatestRuns,
  startSyncRun,
  RETENTION_DAYS,
} from "../../src/lib/observability/sync-runs";

const HORA = 3_600_000;
const DIA = 24 * HORA;

function resultado(over: Partial<{ league: string; errors: string[] }> = {}) {
  return {
    league: "Premier League",
    source: "espn",
    teamsCreated: 0,
    teamsUpdated: 0,
    matchesCreated: 1,
    matchesUpdated: 2,
    matchesSkipped: 0,
    errors: [] as string[],
    ...over,
  };
}

describe("computeRunStatus", () => {
  it("success si ninguna competencia tuvo errores", () => {
    expect(computeRunStatus([resultado(), resultado()], [])).toBe("success");
  });
  it("partial si algunas fallaron y otras no", () => {
    expect(computeRunStatus([resultado(), resultado({ errors: ["x"] })], [])).toBe("partial");
  });
  it("failed si todas fallaron", () => {
    expect(computeRunStatus([resultado({ errors: ["x"] }), resultado({ errors: ["y"] })], [])).toBe("failed");
  });
  it("un hallazgo de severidad error baja success a partial", () => {
    expect(computeRunStatus([resultado()], [{ code: "match_same_team", severity: "error", count: 1, sample: [] }])).toBe(
      "partial"
    );
  });
  it("un hallazgo warn no cambia el estado", () => {
    expect(computeRunStatus([resultado()], [{ code: "stale_scheduled", severity: "warn", count: 3, sample: [] }])).toBe(
      "success"
    );
  });
});

describe("sync_runs (D1)", () => {
  let t: TestDb;
  let db: Database;

  beforeAll(async () => {
    t = await createTestDb();
    db = createDb(t.DB);
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    await t.DB.prepare("DELETE FROM sync_runs").run();
  });

  it("startSyncRun crea un run en estado running", async () => {
    const id = await startSyncRun(db, "cron", 1_000);
    const [run] = await getLatestRuns(db, 1);
    expect(run).toMatchObject({ id, trigger: "cron", status: "running", startedAt: 1_000, finishedAt: null });
  });

  it("finishSyncRun guarda estado, duración, resultados e issues", async () => {
    const id = await startSyncRun(db, "admin", 1_000);
    const issues = [{ code: "stale_scheduled", severity: "warn" as const, count: 2, sample: ["a", "b"] }];
    const status = await finishSyncRun(db, id, { results: [resultado()], issues }, 4_000);
    expect(status).toBe("success");
    const [run] = await getLatestRuns(db, 1);
    expect(run).toMatchObject({ status: "success", durationMs: 3_000, finishedAt: 4_000 });
    expect(run.results[0]).toMatchObject({ league: "Premier League", matchesCreated: 1 });
    expect(run.issues).toEqual(issues);
  });

  it("finishSyncRun devuelve partial y failed según los errores", async () => {
    const a = await startSyncRun(db, "cron", 1_000);
    expect(await finishSyncRun(db, a, { results: [resultado(), resultado({ errors: ["x"] })], issues: [] }, 2_000)).toBe(
      "partial"
    );
    const b = await startSyncRun(db, "cron", 3_000);
    expect(await finishSyncRun(db, b, { results: [resultado({ errors: ["x"] })], issues: [] }, 4_000)).toBe("failed");
  });

  it("acota los errores guardados (cantidad y largo)", async () => {
    const id = await startSyncRun(db, "cron", 1_000);
    const errores = Array.from({ length: 30 }, () => "x".repeat(2_000));
    await finishSyncRun(db, id, { results: [resultado({ errors: errores })], issues: [] }, 2_000);
    const [run] = await getLatestRuns(db, 1);
    expect(run.results[0].errors).toHaveLength(10);
    expect(run.results[0].errors[0].length).toBeLessThanOrEqual(500);
  });

  it("failSyncRun marca failed y guarda el error truncado", async () => {
    const id = await startSyncRun(db, "cron", 1_000);
    await failSyncRun(db, id, new Error("y".repeat(2_000)), 2_500);
    const [run] = await getLatestRuns(db, 1);
    expect(run).toMatchObject({ status: "failed", durationMs: 1_500 });
    expect(run.error!.length).toBeLessThanOrEqual(500);
  });

  it("al iniciar un run se purgan los de más de la retención", async () => {
    const ahora = 100 * DIA;
    const viejo = await startSyncRun(db, "cron", ahora - (RETENTION_DAYS + 1) * DIA);
    const reciente = await startSyncRun(db, "cron", ahora - 2 * DIA);
    const nuevo = await startSyncRun(db, "cron", ahora);
    const ids = (await getLatestRuns(db, 10)).map((r) => r.id);
    expect(ids).toContain(reciente);
    expect(ids).toContain(nuevo);
    expect(ids).not.toContain(viejo);
  });

  it("getLatestRuns ordena del más nuevo al más viejo y respeta el límite", async () => {
    const a = await startSyncRun(db, "cron", 1_000);
    const b = await startSyncRun(db, "cron", 2_000);
    const c = await startSyncRun(db, "cron", 3_000);
    expect((await getLatestRuns(db, 2)).map((r) => r.id)).toEqual([c, b]);
    expect(a).toBeTruthy();
  });
});
