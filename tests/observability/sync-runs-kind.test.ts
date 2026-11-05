// sync_runs.kind (docs/17 B6): los runs de ligas y de calendarios comparten tabla pero no estado.
import { describe, expect, it } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import {
  finishSyncRun,
  getLastSuccessAt,
  getLatestRuns,
  registrarRunCalendarios,
  RETENTION_DAYS,
  startSyncRun,
} from "../../src/lib/observability/sync-runs";

const DIA = 24 * 3_600_000;
const RESUMEN_VACIO = { usuarios: 0, eventosOk: 0, eventosFallidos: 0, sinAcceso: 0, cortadoPorPresupuesto: false, quedan: false, subrequests: 0 };

describe("sync_runs.kind", () => {
  const t = useTestDb();

  it("un run nuevo es de ligas por defecto y los de calendarios se piden por separado", async () => {
    const ligas = await startSyncRun(t.db, "admin", 1_000);
    const cal = await registrarRunCalendarios(t.db, {
      trigger: "admin",
      startedAt: 2_000,
      finishedAt: 2_500,
      status: "success",
      resumen: { usuarios: 3, eventosOk: 5, eventosFallidos: 0, sinAcceso: 1, cortadoPorPresupuesto: false, quedan: false, subrequests: 30 },
    });
    expect((await getLatestRuns(t.db, 10)).map((r) => [r.id, r.kind])).toEqual([[cal, "calendars"], [ligas, "leagues"]]);
    expect((await getLatestRuns(t.db, 10, "leagues")).map((r) => r.id)).toEqual([ligas]);
    const [run] = await getLatestRuns(t.db, 10, "calendars");
    expect(run).toMatchObject({ status: "success", durationMs: 500, finishedAt: 2_500, trigger: "admin" });
    expect(run.results[0]).toMatchObject({ usuarios: 3, sinAcceso: 1 });
  });

  it("registrarRunCalendarios purga los runs viejos como startSyncRun", async () => {
    const viejo = await registrarRunCalendarios(t.db, { trigger: "admin", startedAt: 1_000, finishedAt: 1_100, status: "success", resumen: RESUMEN_VACIO });
    const limite = (RETENTION_DAYS + 1) * DIA;
    await registrarRunCalendarios(t.db, { trigger: "admin", startedAt: limite, finishedAt: limite + 1, status: "success", resumen: RESUMEN_VACIO });
    expect((await getLatestRuns(t.db, 10)).map((r) => r.id)).not.toContain(viejo);
  });

  it("registra un fallo con su mensaje truncado", async () => {
    await registrarRunCalendarios(t.db, { trigger: "admin", startedAt: 1_000, finishedAt: 1_100, status: "failed", resumen: RESUMEN_VACIO, error: new Error("z".repeat(2_000)) });
    const [run] = await getLatestRuns(t.db, 1, "calendars");
    expect(run.status).toBe("failed");
    expect(run.error!.length).toBeLessThanOrEqual(500);
  });

  it("getLastSuccessAt filtra por tipo", async () => {
    const a = await startSyncRun(t.db, "cron", 1_000);
    await finishSyncRun(t.db, a, { results: [], issues: [] }, 2_000);
    await registrarRunCalendarios(t.db, { trigger: "admin", startedAt: 5_000, finishedAt: 6_000, status: "success", resumen: RESUMEN_VACIO });
    expect(await getLastSuccessAt(t.db)).toBe(2_000);
    expect(await getLastSuccessAt(t.db, "calendars")).toBe(6_000);
  });
});
