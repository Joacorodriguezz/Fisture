// Presupuesto de subrequests de una pasada del prode (docs/40 D4), medido en la request completa (middleware
// incluido) con la D1 instrumentada, el KV contado y fetch simulado. Workers Free admite 50 por invocación.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, relojFijo } from "../../helpers/clock";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { evento, PENALES, resumenPenales, sembrarPartidos } from "../../helpers/prode-sync";
import { contarD1, Presupuesto, PRESUPUESTO_SUBREQUESTS } from "../../../src/lib/calendar/presupuesto";

type Mw = (ctx: unknown, next: () => Promise<Response>) => Promise<Response>;
vi.mock("astro:middleware", () => ({
  defineMiddleware: (fn: unknown) => fn,
  sequence: (...fns: Mw[]) => (ctx: unknown, next: () => Promise<Response>) =>
    fns.reduceRight<() => Promise<Response>>((sig, fn) => () => fn(ctx, sig), next)(),
}));

import { onRequest } from "../../../src/middleware";
import { POST } from "../../../src/pages/api/admin/prode/sync";

const H = 3_600_000;

// D1 que cuenta como Cloudflare: una subrequest por consulta ejecutada y una por batch entero
function comoCloudflare(DB: D1Database, gastar: () => void): D1Database {
  const reales = new WeakMap<object, D1PreparedStatement>();
  const envolver = (real: D1PreparedStatement): D1PreparedStatement => {
    const envuelta = new Proxy(real, {
      get(st, p) {
        if (p === "bind") return (...args: unknown[]) => envolver(st.bind(...args));
        const v = Reflect.get(st, p);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => (gastar(), v.apply(st, args));
      },
    });
    reales.set(envuelta, real);
    return envuelta;
  };
  return new Proxy(DB, {
    get(target, prop) {
      if (prop === "prepare") return (sql: string) => envolver(target.prepare(sql));
      if (prop === "batch") return (stmts: D1PreparedStatement[]) => (gastar(), target.batch(stmts.map((s) => reales.get(s) ?? s)));
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

describe("presupuesto de subrequests de POST /api/admin/prode/sync", () => {
  const t = useTestDb();
  relojFijo();
  let usado: { d1: number; kv: number; espn: number; resumen: number };
  // Intentos fallidos antes de que cada URL responda
  let fallosPorUrl: number;
  let eventos: Record<string, unknown[]>;

  beforeEach(() => {
    silenciarConsola(vi);
    usado = { d1: 0, kv: 0, espn: 0, resumen: 0 };
    fallosPorUrl = 0;
    eventos = {};
    const intentos = new Map<string, number>();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const [liga, recurso] = new URL(String(url)).pathname.split("/").slice(-2);
      usado[recurso === "summary" ? "resumen" : "espn"]++;
      const n = (intentos.get(String(url)) ?? 0) + 1;
      intentos.set(String(url), n);
      if (n <= fallosPorUrl) return new Response("{}", { status: 500 });
      return Response.json(recurso === "summary" ? resumenPenales() : { events: eventos[liga] ?? [] });
    }));
  });

  const sembrar = async (ligas: string[], porLiga: number) => {
    let id = 0;
    for (const liga of ligas) {
      const partidos = Array.from({ length: porLiga }, () => ({ id: ++id, liga, inicio: AHORA.getTime() - 3 * H }));
      await sembrarPartidos(t.db, partidos);
      eventos[liga] = partidos.map((p) => evento(p.id, p.inicio, PENALES));
    }
  };

  const request = async (DB: D1Database) => {
    const kv = kvEnMemoria();
    const KV = { ...kv, get: async (k: string) => (usado.kv++, kv.get(k)) };
    const ctx = apiCtx({
      url: "https://fisture.test/api/admin/prode/sync",
      method: "POST",
      headers: { Authorization: "Bearer s3" },
      env: { ENVIRONMENT: "test", DB, KV, ADMIN_SECRET: "s3" },
      over: { cookies: { get: () => undefined, delete: vi.fn() } },
    });
    ctx.locals.runtime.ctx = { waitUntil: () => {} };
    const res: Response = await (onRequest as any)(ctx, () => POST(ctx));
    return (await res.json()) as any;
  };
  const contada = () => comoCloudflare(t.DB, () => usado.d1++);
  const total = () => usado.d1 + usado.kv + usado.espn + usado.resumen;

  it("sin pendientes: 1 subrequest (la consulta)", async () => {
    expect((await request(contada())).trabajo).toBe(false);
    expect(usado).toEqual({ d1: 1, kv: 0, espn: 0, resumen: 0 });
  });

  it("normal: un partido en 90' gasta 7", async () => {
    await sembrar(["arg.1"], 1);
    eventos["arg.1"] = [evento(1, AHORA.getTime() - 3 * H)];
    expect((await request(contada())).status).toBe("success");
    expect(usado).toEqual({ d1: 5, kv: 1, espn: 1, resumen: 0 });
  });

  // 3 competencias y cada pedido a ESPN recién responde al tercer intento. Sin los summaries son 19 como
  // mucho (consulta, KV, 9 a ESPN, 3 lecturas, 1 batch y 2 del run: 17); los summaries suman hasta 3 x 3.
  it("peor caso: hasta 19 sin los summaries y 26 con ellos", async () => {
    await sembrar(["arg.1", "conmebol.libertadores", "conmebol.sudamericana"], 2);
    fallosPorUrl = 2;
    expect((await request(contada())).status).toBe("success");
    expect(usado).toEqual({ d1: 7, kv: 1, espn: 9, resumen: 9 });
    expect(total() - usado.resumen).toBeLessThanOrEqual(19);
    expect(total()).toBe(26);
  });

  // Contando cada sentencia del batch (criterio conservador de calendar/presupuesto.ts)
  it("ocho cruces definidos por penales a la vez entran en el margen aun contando cada sentencia", async () => {
    await sembrar(["arg.1"], 8);
    fallosPorUrl = 2;
    const presupuesto = new Presupuesto(PRESUPUESTO_SUBREQUESTS);
    expect((await request(contarD1(t.DB, presupuesto))).status).toBe("success");
    expect(presupuesto.usado + total()).toBeLessThan(PRESUPUESTO_SUBREQUESTS);
  });
});
