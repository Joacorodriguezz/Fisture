import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { apiCtx } from "../helpers/ctx";
import { seedApp } from "../helpers/fixtures";
import { createSession } from "../../src/lib/auth/session";
import { failSyncRun, finishSyncRun, startSyncRun } from "../../src/lib/observability/sync-runs";
import {
  evaluateSyncHealth,
  getHealth,
  overallStatus,
  RUN_HUNG_AFTER_MS,
  SYNC_DEGRADED_MAX_AGE_MS,
  SYNC_OK_MAX_AGE_MS,
} from "../../src/lib/observability/health";
import { GET as healthGET } from "../../src/pages/api/health";
import { GET as statusGET } from "../../src/pages/api/admin/status";

const H = 3_600_000;
const NOW = 1_800_000_000_000;

describe("evaluateSyncHealth (puro)", () => {
  const ok = { status: "success" as const, startedAt: NOW - 2 * H, finishedAt: NOW - 2 * H + 1000 };

  it("sin runs: fail (puede ser un cron que nunca corrió)", () => {
    expect(evaluateSyncHealth({ latest: null, lastSuccessAt: null, now: NOW })).toBe("fail");
  });
  it("success reciente: ok", () => {
    expect(evaluateSyncHealth({ latest: ok, lastSuccessAt: ok.finishedAt, now: NOW })).toBe("ok");
  });
  it("success justo en el límite de 26 h: ok", () => {
    const borde = { ...ok, finishedAt: NOW - SYNC_OK_MAX_AGE_MS };
    expect(evaluateSyncHealth({ latest: borde, lastSuccessAt: borde.finishedAt, now: NOW })).toBe("ok");
  });
  it("success un ms pasado el límite de 26 h: degraded", () => {
    const borde = { ...ok, finishedAt: NOW - SYNC_OK_MAX_AGE_MS };
    expect(evaluateSyncHealth({ latest: borde, lastSuccessAt: borde.finishedAt - 1, now: NOW })).toBe("degraded");
  });
  it("success entre 26 h y 50 h: degraded", () => {
    const a = NOW - 30 * H;
    expect(evaluateSyncHealth({ latest: { ...ok, finishedAt: a }, lastSuccessAt: a, now: NOW })).toBe("degraded");
  });
  it("success de más de 50 h: fail", () => {
    const b = NOW - SYNC_DEGRADED_MAX_AGE_MS - 1;
    expect(evaluateSyncHealth({ latest: { ...ok, finishedAt: b }, lastSuccessAt: b, now: NOW })).toBe("fail");
  });
  it("último run failed: fail aunque haya un success reciente", () => {
    const failed = { status: "failed" as const, startedAt: NOW - H, finishedAt: NOW - H };
    expect(evaluateSyncHealth({ latest: failed, lastSuccessAt: NOW - 2 * H, now: NOW })).toBe("fail");
  });
  it("último run partial reciente: degraded; partial de hace más de 50 h: fail", () => {
    const p = { status: "partial" as const, startedAt: NOW - H, finishedAt: NOW - H };
    expect(evaluateSyncHealth({ latest: p, lastSuccessAt: null, now: NOW })).toBe("degraded");
    const viejo = { ...p, finishedAt: NOW - SYNC_DEGRADED_MAX_AGE_MS - 1 };
    expect(evaluateSyncHealth({ latest: viejo, lastSuccessAt: null, now: NOW })).toBe("fail");
  });
  it("run running colgado (más de 10 min): fail", () => {
    const colgado = { status: "running" as const, startedAt: NOW - RUN_HUNG_AFTER_MS - 1, finishedAt: null };
    expect(evaluateSyncHealth({ latest: colgado, lastSuccessAt: NOW - H, now: NOW })).toBe("fail");
  });
  it("run running reciente: se juzga por el último success (o degraded si no hay)", () => {
    const corriendo = { status: "running" as const, startedAt: NOW - 60_000, finishedAt: null };
    expect(evaluateSyncHealth({ latest: corriendo, lastSuccessAt: NOW - H, now: NOW })).toBe("ok");
    expect(evaluateSyncHealth({ latest: corriendo, lastSuccessAt: null, now: NOW })).toBe("degraded");
  });
});

describe("overallStatus", () => {
  it("fail > degraded > ok", () => {
    expect(overallStatus({ db: "ok", kv: "ok", sync: "ok" })).toBe("ok");
    expect(overallStatus({ db: "ok", kv: "ok", sync: "degraded" })).toBe("degraded");
    expect(overallStatus({ db: "ok", kv: "fail", sync: "degraded" })).toBe("fail");
  });
});

describe("getHealth y endpoints (D1)", () => {
  const t = useTestDb();
  const kvOk = { get: async () => null } as any;
  const kvRoto = {
    get: async () => {
      throw new Error("KV caído");
    },
  } as any;

  const ctxHealth = (env: any) => apiCtx({ url: "https://fisture.test/api/health", env });

  const ctxStatus = (env: any, auth?: string) =>
    apiCtx({ url: "https://fisture.test/api/admin/status", env, headers: auth ? { Authorization: auth } : {} });

  // withApi loguea cada request con el rootLogger (console.*): se silencia para no ensuciar la salida
  beforeEach(() => {
    for (const metodo of ["log", "warn", "error"] as const) vi.spyOn(console, metodo).mockImplementation(() => {});
  });

  const syncExitoso = async (cuando: number) => {
    const id = await startSyncRun(t.db, "cron", cuando);
    await finishSyncRun(t.db, id, { results: [], issues: [] }, cuando + 1000);
  };

  it("getHealth ok con un sync reciente", async () => {
    await syncExitoso(Date.now() - H);
    const h = await getHealth({ DB: t.DB, KV: kvOk, OAUTH_STATE_SECRET: "secret" });
    expect(h.status).toBe("ok");
    expect(h.checks).toEqual({ db: "ok", kv: "ok", sync: "ok", oauthState: "ok" });
    expect(h.lastSyncAt).toBeTruthy();
  });

  it("getHealth: KV roto => fail en kv", async () => {
    await syncExitoso(Date.now() - H);
    const h = await getHealth({ DB: t.DB, KV: kvRoto });
    expect(h.checks.kv).toBe("fail");
    expect(h.status).toBe("fail");
  });

  const dbRota = {
    prepare: () => {
      throw new Error("D1 caída");
    },
  } as any;

  it("getHealth: D1 rota => db en fail y estado general fail", async () => {
    const h = await getHealth({ DB: dbRota, KV: kvOk, OAUTH_STATE_SECRET: "secret" });
    expect(h.checks.db).toBe("fail");
    expect(h.status).toBe("fail");
  });

  it("getHealth: sin poder consultar D1 no se evalúa el sync y queda en fail", async () => {
    const h = await getHealth({ DB: dbRota, KV: kvOk, OAUTH_STATE_SECRET: "secret" });
    expect(h.checks.sync).toBe("fail");
    expect(h.lastSyncAt).toBeNull();
  });

  it("getHealth: D1 sana pero la tabla de runs ilegible => solo sync en fail", async () => {
    await syncExitoso(Date.now() - H); // con runs legibles daría ok: el fail viene de la lectura
    const dbSinRuns = {
      prepare: (sql: string) => {
        if (sql.includes("sync_runs")) throw new Error("no such table: sync_runs");
        return t.DB.prepare(sql);
      },
    } as any;
    const h = await getHealth({ DB: dbSinRuns, KV: kvOk, OAUTH_STATE_SECRET: "secret" });
    expect(h.checks).toMatchObject({ db: "ok", sync: "fail" });
  });

  it("GET /api/health: 200 con base sana", async () => {
    await syncExitoso(Date.now() - H);
    const res = await healthGET(ctxHealth({ DB: t.DB, KV: kvOk, OAUTH_STATE_SECRET: "secret" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("ok");
  });

  it("GET /api/health: 503 si el sync está en fail (sin runs)", async () => {
    const res = await healthGET(ctxHealth({ DB: t.DB, KV: kvOk, OAUTH_STATE_SECRET: "secret" }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).checks.sync).toBe("fail");
  });

  it("L10: sin OAUTH_STATE_SECRET el check oauthState falla y /api/health responde 503", async () => {
    await syncExitoso(Date.now() - H);
    const res = await healthGET(ctxHealth({ DB: t.DB, KV: kvOk }));
    expect(res.status).toBe(503);
    expect(((await res.json()) as any).checks).toMatchObject({ db: "ok", kv: "ok", sync: "ok", oauthState: "fail" });
  });

  it("GET /api/health no expone detalles internos", async () => {
    const id = await startSyncRun(t.db, "cron", Date.now() - H);
    await failSyncRun(t.db, id, new Error("clave secreta de ESPN: abc"), Date.now());
    const res = await healthGET(ctxHealth({ DB: t.DB, KV: kvOk, OAUTH_STATE_SECRET: "secret" }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["checks", "lastSyncAt", "status"]);
    expect(Object.keys(body.checks as object).sort()).toEqual(["db", "kv", "oauthState", "sync"]);
    expect(JSON.stringify(body)).not.toContain("clave secreta");
  });

  it("GET /api/admin/status: 401 sin token o con token incorrecto", async () => {
    const env = { DB: t.DB, KV: kvOk, ADMIN_SECRET: "s3", OAUTH_STATE_SECRET: "secret" };
    expect((await statusGET(ctxStatus(env))).status).toBe(401);
    expect((await statusGET(ctxStatus(env, "Bearer otro"))).status).toBe(401);
  });

  it("GET /api/admin/status: 401 si no hay ADMIN_SECRET configurado", async () => {
    expect((await statusGET(ctxStatus({ DB: t.DB, KV: kvOk, OAUTH_STATE_SECRET: "secret" }, "Bearer undefined"))).status).toBe(401);
  });

  it("GET /api/admin/status: 200 con token y devuelve los runs", async () => {
    await syncExitoso(Date.now() - H);
    await syncExitoso(Date.now() - 2 * H);
    const env = { DB: t.DB, KV: kvOk, ADMIN_SECRET: "s3", OAUTH_STATE_SECRET: "secret" };
    const res = await statusGET(ctxStatus(env, "Bearer s3"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.runs).toHaveLength(2);
    expect(body.runs[0]).toMatchObject({ status: "success", trigger: "cron" });
    expect(body.health.status).toBe("ok");
  });

  it("S18: GET /api/admin/status incluye el conteo de sesiones, sin ids", async () => {
    await syncExitoso(Date.now() - H);
    await seedApp(t.db);
    await createSession(t.db, "user-1");
    await createSession(t.db, "user-1", new Date(Date.now() - 31 * 24 * H));
    const env = { DB: t.DB, KV: kvOk, ADMIN_SECRET: "s3", OAUTH_STATE_SECRET: "secret" };
    const res = await statusGET(ctxStatus(env, "Bearer s3"));
    const body = (await res.json()) as any;
    expect(body.sessions).toEqual({ vigentes: 1, vencidas: 1 });
  });
});
