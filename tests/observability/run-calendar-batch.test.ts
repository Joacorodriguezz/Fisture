// Un lote de reconciliación de calendarios como lo dispara el workflow (docs/17): registra su run
// con kind = calendars, arma el barrido con el corte y respeta el presupuesto de subrequests.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { apiCtx, silenciarConsola } from "../helpers/ctx";
import { clienteFalso, getToken, insertarSync, sembrar, setMatch, T0 } from "../helpers/calendar";
import { getLatestRuns } from "../../src/lib/observability/sync-runs";
import { runCalendarBatch } from "../../src/lib/observability/run-calendar-batch";
import { POST } from "../../src/pages/api/admin/sync";
import { CalendarApiError } from "../../src/lib/calendar/errors";

describe("runCalendarBatch", () => {
  const t = useTestDb();
  let falso: ReturnType<typeof clienteFalso>;
  const NOW = (T0 - 86_400) * 1000;

  const correr = (opts: Parameters<typeof runCalendarBatch>[1] = {}) =>
    runCalendarBatch({ DB: t.DB } as never, { now: () => NOW, deps: { client: falso.client, getToken }, ...opts });

  beforeEach(async () => {
    silenciarConsola(vi);
    falso = clienteFalso();
    await sembrar(t as never, ["m1", "m2"]);
    await insertarSync(t as never, { id: "s1", match: "m1", user: "u1" });
    await insertarSync(t as never, { id: "s2", match: "m1", user: "u2" });
    await setMatch(t as never, "m1", { dateTime: T0 + 60 });
  });

  it("el primer lote (sin corte) detecta los eventos desactualizados, abre el barrido y registra el run", async () => {
    const r = await correr();
    expect(r).toMatchObject({ status: "success", corte: NOW, siguiente: false, resumen: { usuarios: 2, eventosOk: 2, sinAcceso: 0 } });
    expect(falso.llamadas.update).toBe(2);
    const [run] = await getLatestRuns(t.db, 5, "calendars");
    expect(run).toMatchObject({ id: r.runId, kind: "calendars", status: "success", trigger: "admin", finishedAt: NOW });
    expect(run.results[0]).toMatchObject({ usuarios: 2, eventosOk: 2 });
    expect(await getLatestRuns(t.db, 5, "leagues")).toEqual([]);
  });

  it("un lote con corte no vuelve a revisar eventos y no repite a quien ya atendió ese barrido", async () => {
    await correr();
    await setMatch(t as never, "m1", { dateTime: T0 + 7200 });
    const r = await correr({ corte: NOW });
    expect(r.resumen.usuarios).toBe(0);
    expect(falso.llamadas.update).toBe(2); // el segundo lote no tocó nada
    expect(r.siguiente).toBe(false);
  });

  it("un 401 se informa como sinAcceso pero el run es success: es un problema del usuario, no del sistema", async () => {
    falso.fallos.update = () => new CalendarApiError("unauthorized", 401);
    const r = await correr();
    expect(r).toMatchObject({ status: "success", resumen: { sinAcceso: 2 } });
  });

  it("sin lugar ni para un usuario el run queda partial (sin progreso) y pide seguir", async () => {
    const r = await correr({ presupuesto: 8 });
    expect(r).toMatchObject({ status: "partial", siguiente: true, resumen: { usuarios: 0, cortadoPorPresupuesto: true } });
  });

  it("usa como máximo 50 subrequests: consultas D1 más llamadas al calendario", async () => {
    for (let i = 0; i < 12; i++) {
      await t.DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES (?, ?, ?, 'google', ?)").bind(`x${i}`, `x${i}@x`, `x${i}`, `gx${i}`).run();
      await insertarSync(t as never, { id: `sx${i}`, match: "m1", user: `x${i}` });
    }
    let consultas = 0;
    const DB = new Proxy(t.DB, {
      get(target, prop, receiver) {
        if (prop !== "prepare") return Reflect.get(target, prop, receiver);
        return (sql: string) => {
          const envolver = (st: any): any =>
            new Proxy(st, {
              get(o, k) {
                if (k === "bind") return (...a: unknown[]) => envolver(o.bind(...a));
                if (["run", "all", "first", "raw"].includes(k as string)) return (...a: unknown[]) => (consultas++, o[k](...a));
                return o[k];
              },
            });
          return envolver(target.prepare(sql));
        };
      },
    }) as typeof t.DB;
    const r = await runCalendarBatch({ DB } as never, { now: () => NOW, deps: { client: falso.client, getToken } });
    expect(consultas + falso.total()).toBeLessThanOrEqual(50);
    expect(r.resumen.subrequests).toBeLessThanOrEqual(50);
    expect(r.resumen.usuarios).toBeGreaterThan(0);
    expect(r.siguiente).toBe(true);
  });

  it("si el lote explota registra un run failed con el error y no lo deja sin rastro", async () => {
    const DB = new Proxy(t.DB, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("calendar_syncs") && sql.includes("EXISTS")) throw new Error("D1 se cayó");
            return target.prepare(sql);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof t.DB;
    const r = await runCalendarBatch({ DB } as never, { now: () => NOW, deps: { client: falso.client, getToken } });
    expect(r).toMatchObject({ status: "failed", error: expect.stringContaining("D1 se cayó") });
    const [run] = await getLatestRuns(t.db, 5, "calendars");
    expect(run).toMatchObject({ status: "failed" });
  });
});

describe("POST /api/admin/sync con calendarios", () => {
  const t = useTestDb();
  const env = (extra = {}) => ({ DB: t.DB, ADMIN_SECRET: "s3", ENVIRONMENT: "production", ...extra });
  const llamar = (body: unknown, auth: string | null = "Bearer s3") =>
    POST(apiCtx({ url: "https://fisture.test/api/admin/sync", method: "POST", headers: auth ? { Authorization: auth } : {}, body, env: env() }));

  beforeEach(() => silenciarConsola(vi));

  it("sin token responde 401", async () => {
    expect((await llamar({ calendarios: true }, null)).status).toBe(401);
  });

  it("devuelve el estado del lote y si hay que seguir; sin trabajo cierra el barrido", async () => {
    const res = await llamar({ calendarios: true });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      success: true,
      kind: "calendars",
      status: "success",
      siguiente: false,
      usuarios: 0,
      corte: expect.any(Number),
      runId: expect.any(String),
    });
  });

  it("el corte de un barrido en curso se reenvía en los lotes siguientes", async () => {
    const primero = (await (await llamar({ calendarios: true })).json()) as { corte: number };
    const segundo = (await (await llamar({ calendarios: true, corte: primero.corte })).json()) as { corte: number };
    expect(segundo.corte).toBe(primero.corte);
  });

  it.each([["texto", "ayer"], ["negativo", -5], ["decimal", 1.5], ["cero", 0]])("un corte inválido (%s) responde 400", async (_c, corte) => {
    const res = await llamar({ calendarios: true, corte });
    expect(res.status).toBe(400);
  });
});
