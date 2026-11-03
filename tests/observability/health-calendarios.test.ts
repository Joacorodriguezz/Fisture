// Salud de los calendarios separada de la de ligas (docs/17 B6).
import { describe, expect, it } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { evaluateCalendarHealth, getHealth, SYNC_DEGRADED_MAX_AGE_MS, SYNC_OK_MAX_AGE_MS } from "../../src/lib/observability/health";
import { finishSyncRun, registrarRunCalendarios, startSyncRun } from "../../src/lib/observability/sync-runs";

const H = 3_600_000;
const NOW = 1_800_000_000_000;
const RESUMEN = { usuarios: 1, eventosOk: 1, eventosFallidos: 0, sinAcceso: 0, cortadoPorPresupuesto: false, quedan: false, subrequests: 10 };
const kv = { get: async () => null } as never;

describe("evaluateCalendarHealth (puro)", () => {
  const run = (status: "success" | "partial" | "failed", hace: number) => ({ status, startedAt: NOW - hace, finishedAt: NOW - hace });

  it("sin runs de calendarios: ok (el disparo ya lo vigila el check de ligas)", () => {
    expect(evaluateCalendarHealth({ latest: null, lastSuccessAt: null, now: NOW })).toBe("ok");
  });
  it("success reciente: ok; entre 26 y 50 h: degraded; más de 50 h: fail", () => {
    expect(evaluateCalendarHealth({ latest: run("success", H), lastSuccessAt: NOW - H, now: NOW })).toBe("ok");
    expect(evaluateCalendarHealth({ latest: run("success", SYNC_OK_MAX_AGE_MS + 1), lastSuccessAt: NOW - SYNC_OK_MAX_AGE_MS - 1, now: NOW })).toBe("degraded");
    expect(evaluateCalendarHealth({ latest: run("success", SYNC_DEGRADED_MAX_AGE_MS + 1), lastSuccessAt: NOW - SYNC_DEGRADED_MAX_AGE_MS - 1, now: NOW })).toBe("fail");
  });
  it("último run failed: fail; partial (barrido incompleto): degraded", () => {
    expect(evaluateCalendarHealth({ latest: run("failed", H), lastSuccessAt: NOW - 2 * H, now: NOW })).toBe("fail");
    expect(evaluateCalendarHealth({ latest: run("partial", H), lastSuccessAt: NOW - 2 * H, now: NOW })).toBe("degraded");
  });
});

describe("getHealth con runs de calendarios (D1)", () => {
  const t = useTestDb();
  const env = () => ({ DB: t.DB, KV: kv, OAUTH_STATE_SECRET: "s" });

  const ligasOk = async (cuando: number) => {
    const id = await startSyncRun(t.db, "admin", cuando);
    await finishSyncRun(t.db, id, { results: [], issues: [] }, cuando + 1000);
  };
  const calendarios = (cuando: number, status: "success" | "partial" | "failed") =>
    registrarRunCalendarios(t.db, { trigger: "admin", startedAt: cuando, finishedAt: cuando + 1000, status, resumen: RESUMEN });

  it("sin runs de calendarios el estado depende solo de las ligas", async () => {
    await ligasOk(Date.now() - H);
    const h = await getHealth(env());
    expect(h.checks).toEqual({ db: "ok", kv: "ok", sync: "ok", calendars: "ok", oauthState: "ok" });
    expect(h.lastCalendarSyncAt).toBeNull();
  });

  it("un run de calendarios fallido no tapa ni rompe el check de ligas, pero el estado general falla", async () => {
    await ligasOk(Date.now() - 2 * H);
    await calendarios(Date.now() - H, "failed");
    const h = await getHealth(env());
    expect(h.checks.sync).toBe("ok");
    expect(h.checks.calendars).toBe("fail");
    expect(h.status).toBe("fail");
  });

  it("un run de ligas exitoso no tapa que los calendarios llevan días sin procesarse", async () => {
    await ligasOk(Date.now() - H);
    await calendarios(Date.now() - 60 * H, "success");
    const h = await getHealth(env());
    expect(h.checks).toMatchObject({ sync: "ok", calendars: "fail" });
    expect(h.lastCalendarSyncAt).toEqual(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });

  it("calendarios recientes y ligas recientes: todo ok", async () => {
    await ligasOk(Date.now() - H);
    await calendarios(Date.now() - H, "success");
    expect((await getHealth(env())).status).toBe("ok");
  });
});
