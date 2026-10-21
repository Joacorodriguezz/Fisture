import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/d1";
import { createLogger } from "../../src/lib/observability/logger";
import { createDb, type Database } from "../../src/lib/db";
import { getLatestRuns } from "../../src/lib/observability/sync-runs";
import { runSync, type RunSyncDeps } from "../../src/lib/observability/run-sync";

function res(league: string, errors: string[] = []) {
  return {
    league,
    source: "espn",
    teamsCreated: 0,
    teamsUpdated: 0,
    matchesCreated: 1,
    matchesUpdated: 0,
    matchesSkipped: 0,
    errors,
  };
}

describe("runSync", () => {
  let t: TestDb;
  let db: Database;
  let kvDelete: ReturnType<typeof vi.fn>;
  let env: any;
  let lineas: { level: string; data: Record<string, any> }[];
  let logger: ReturnType<typeof createLogger>;

  const deps = (over: Partial<RunSyncDeps> = {}): RunSyncDeps => ({
    syncAllLeagues: async () => [res("Liga A"), res("Liga B")],
    syncSingleLeague: async (_e, id) => res(id),
    calendarAutoSync: async () => {},
    ...over,
  });

  beforeAll(async () => {
    t = await createTestDb();
    db = createDb(t.DB);
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    await t.DB.prepare("DELETE FROM sync_runs").run();
    await t.DB.prepare("DELETE FROM matches").run();
    await t.DB.prepare("DELETE FROM teams").run();
    await t.DB.prepare("DELETE FROM leagues").run();
    kvDelete = vi.fn(async () => {});
    env = { DB: t.DB, KV: { delete: kvDelete } };
    lineas = [];
    logger = createLogger({ write: (level, line) => lineas.push({ level, data: JSON.parse(line) }) });
  });

  it("sync exitoso: registra el run, invalida la cache y devuelve los resultados", async () => {
    const r = await runSync(env, "cron", { deps: deps(), logger });
    expect(r.status).toBe("success");
    expect(r.results).toHaveLength(2);
    const [run] = await getLatestRuns(db, 1);
    expect(run).toMatchObject({ id: r.runId, trigger: "cron", status: "success" });
    expect(run.results.map((x) => x.league)).toEqual(["Liga A", "Liga B"]);
    expect(kvDelete).toHaveBeenCalledWith("cache:matches:all");
  });

  it("un proveedor que falla produce un run partial y no interrumpe", async () => {
    const r = await runSync(env, "cron", {
      deps: deps({ syncAllLeagues: async () => [res("Liga A"), res("Liga B", ["ESPN 500"])] }),
      logger,
    });
    expect(r.status).toBe("partial");
    const [run] = await getLatestRuns(db, 1);
    expect(run.status).toBe("partial");
    expect(run.results[1].errors).toEqual(["ESPN 500"]);
    expect(lineas.some((l) => l.level === "warn" && l.data.league === "Liga B")).toBe(true);
  });

  it("si todo el sync lanza excepción: run failed, error en el log y sin relanzar", async () => {
    const r = await runSync(env, "cron", {
      deps: deps({
        syncAllLeagues: async () => {
          throw new Error("D1 caída");
        },
      }),
      logger,
    });
    expect(r.status).toBe("failed");
    expect(r.error).toBe("D1 caída");
    const [run] = await getLatestRuns(db, 1);
    expect(run).toMatchObject({ status: "failed", error: "D1 caída" });
    expect(lineas.some((l) => l.level === "error" && l.data.msg === "sync_failed")).toBe(true);
    expect(kvDelete).not.toHaveBeenCalled();
  });

  it("con leagueId sincroniza solo esa competencia", async () => {
    const all = vi.fn(async () => [res("x")]);
    const single = vi.fn(async (_e: unknown, id: string) => res(id));
    const r = await runSync(env, "admin", { leagueId: "arg.1", deps: deps({ syncAllLeagues: all, syncSingleLeague: single }), logger });
    expect(all).not.toHaveBeenCalled();
    expect(single).toHaveBeenCalledTimes(1);
    expect(single.mock.calls[0][1]).toBe("arg.1");
    expect(r.results.map((x) => x.league)).toEqual(["arg.1"]);
  });

  it("el calendario solo se sincroniza si se pide (cron)", async () => {
    const cal = vi.fn(async () => {});
    await runSync(env, "admin", { deps: deps({ calendarAutoSync: cal }), logger });
    expect(cal).not.toHaveBeenCalled();
    await runSync(env, "cron", { calendarAutoSync: true, deps: deps({ calendarAutoSync: cal }), logger });
    expect(cal).toHaveBeenCalledTimes(1);
  });

  it("un fallo del calendario queda como issue y no tumba el sync", async () => {
    const r = await runSync(env, "cron", {
      calendarAutoSync: true,
      deps: deps({
        calendarAutoSync: async () => {
          throw new Error("Google 503");
        },
      }),
      logger,
    });
    expect(r.status).toBe("partial");
    expect(r.issues.find((i) => i.code === "calendar_autosync_failed")).toMatchObject({ severity: "error" });
  });

  it("los hallazgos de consistencia se guardan en el run", async () => {
    await t.DB.prepare("INSERT INTO leagues (id, name, country, external_id, season, is_active) VALUES ('vacia', 'V', 'AR', 'v', 2026, 1)").run();
    const r = await runSync(env, "cron", { deps: deps(), logger });
    expect(r.issues.map((i) => i.code)).toContain("empty_league");
    const [run] = await getLatestRuns(db, 1);
    expect(run.issues.map((i) => i.code)).toContain("empty_league");
  });

  it("sin KV no revienta", async () => {
    const r = await runSync({ DB: t.DB }, "cron", { deps: deps(), logger });
    expect(r.status).toBe("success");
  });
});
