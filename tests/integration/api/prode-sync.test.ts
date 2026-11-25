// POST /api/admin/prode/sync: las pasadas tras el final (docs/40 D4, D6 y §6).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, relojFijo } from "../../helpers/clock";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { d1ConCambioAntesDelBatch } from "../../helpers/d1-intercalado";
import { evento, PENALES, resumenPenales, sembrarPartidos, type EventoOpts, type PartidoSeed } from "../../helpers/prode-sync";
import { POST } from "../../../src/pages/api/admin/prode/sync";
import { consultaPendientes, MAX_COMPETENCIAS_PRODE } from "../../../src/lib/data-providers/prode-pasadas";
import { getLatestRuns } from "../../../src/lib/observability/sync-runs";
import { matches, prodeMatches } from "../../../drizzle/schema";

const H = 3_600_000;
const MIN = 60_000;
const ADMIN = "admin-de-prueba";

describe("POST /api/admin/prode/sync", () => {
  const t = useTestDb();
  relojFijo();
  let kv: ReturnType<typeof kvEnMemoria>;
  let pedidos: string[];
  // Eventos por competencia; una competencia en `caidas` responde 500
  let eventos: Record<string, ReturnType<typeof evento>[]>;
  let caidas: Set<string>;
  let resumen: unknown;
  let inicios: Map<number, number>;

  beforeEach(() => {
    silenciarConsola(vi);
    kv = kvEnMemoria();
    pedidos = [];
    eventos = {};
    caidas = new Set();
    resumen = null;
    inicios = new Map();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      pedidos.push(String(url));
      const [liga, recurso] = new URL(String(url)).pathname.split("/").slice(-2);
      if (caidas.has(liga)) return new Response("{}", { status: 500 });
      if (recurso === "summary") return resumen ? Response.json(resumen) : new Response("{}", { status: 500 });
      return Response.json({ events: eventos[liga] ?? [] });
    }));
  });

  const sembrar = async (...partidos: PartidoSeed[]) => {
    for (const p of partidos) inicios.set(p.id, p.inicio);
    await sembrarPartidos(t.db, partidos);
  };
  const publicar = (id: number, o: EventoOpts = {}, liga = "arg.1") => {
    eventos[liga] = [...(eventos[liga] ?? []).filter((e) => e.id !== String(id)), evento(id, inicios.get(id)!, o)];
  };
  const llamar = async (opts: { DB?: D1Database; auth?: string | null } = {}) => {
    const res = await POST(apiCtx({
      url: "https://fisture.test/api/admin/prode/sync",
      method: "POST",
      headers: opts.auth === null ? {} : { Authorization: opts.auth ?? `Bearer ${ADMIN}` },
      env: { ENVIRONMENT: "test", DB: opts.DB ?? t.DB, KV: kv, ADMIN_SECRET: ADMIN },
    }));
    return { status: res.status, body: (await res.json()) as any };
  };
  const en = (ms: number) => vi.setSystemTime(ms);
  const vinculo = async (id = 1) => (await t.db.select().from(prodeMatches)).find((v) => v.matchId === `m-${id}`)!;
  const partido = async (id = 1) => (await t.db.select().from(matches)).find((m) => m.id === `m-${id}`)!;
  const runs = () => getLatestRuns(t.db, 20);
  const inicio = AHORA.getTime();

  it("sin el Bearer correcto responde 401 y no consulta ESPN", async () => {
    await sembrar({ id: 1, inicio: inicio - 2 * H });
    for (const auth of [null, "Bearer otro"]) expect((await llamar({ auth })).status).toBe(401);
    expect(pedidos).toEqual([]);
  });

  describe("cuándo hay trabajo", () => {
    const sinTrabajo = async () => {
      const get = vi.spyOn(kv, "get");
      const antes = (await runs()).length;
      expect(await llamar()).toEqual({ status: 200, body: { success: true, trabajo: false } });
      expect(pedidos).toEqual([]);
      expect(get).not.toHaveBeenCalled();
      expect(await runs()).toHaveLength(antes);
    };

    it("sin partidos del prode: nada", async () => {
      await sinTrabajo();
    });

    it("a +1 h 59 min no hay trabajo; a +2 h sí", async () => {
      await sembrar({ id: 1, inicio });
      publicar(1);
      en(inicio + 2 * H - MIN);
      await sinTrabajo();
      en(inicio + 2 * H);
      expect((await llamar()).body).toMatchObject({ trabajo: true, status: "success", partidos: 1, competencias: 1 });
      expect((await vinculo()).pasadaAt).toBe(inicio + 2 * H);
    });

    it("dato sin confirmar: la corrida siguiente lo confirma; después no se repite hasta +3 h", async () => {
      await sembrar({ id: 1, inicio });
      publicar(1);
      en(inicio + 2 * H);
      await llamar();
      expect(await vinculo()).toMatchObject({ autoRegla: "A", autoConfirmadoAt: null });

      en(inicio + 2 * H + 15 * MIN);
      expect((await llamar()).body).toMatchObject({ trabajo: true, confirmados: 1 });
      expect((await vinculo()).autoConfirmadoAt).toBe(inicio + 2 * H + 15 * MIN);

      pedidos = [];
      en(inicio + 3 * H - MIN);
      await sinTrabajo();
      en(inicio + 3 * H);
      expect((await llamar()).body).toMatchObject({ trabajo: true, cambios: 0, confirmados: 0 });

      pedidos = [];
      en(inicio + 3 * H + 15 * MIN);
      await sinTrabajo();
    });

    it("un partido que sigue en vivo queda pendiente hasta +6 h", async () => {
      await sembrar({ id: 1, inicio });
      publicar(1, { estado: "STATUS_IN_PROGRESS", state: "in" });
      for (const despues of [2 * H, 3 * H, 3 * H + 15 * MIN, 6 * H - MIN]) {
        en(inicio + despues);
        expect((await llamar()).body.trabajo).toBe(true);
      }
      pedidos = [];
      en(inicio + 6 * H);
      await sinTrabajo();
    });

    it("pasadas las 6 h sin confirmar, queda para el sync diario", async () => {
      await sembrar({ id: 1, inicio });
      await t.DB.prepare("UPDATE prode_matches SET pasada_at = ?1, auto_visto_at = ?1").bind(inicio + 4 * H).run();
      en(inicio + 6 * H);
      await sinTrabajo();
    });

    it("una pasada atrasada sigue pendiente aunque pasen las 6 h", async () => {
      await sembrar({ id: 1, inicio });
      publicar(1);
      en(inicio + 20 * H);
      expect((await llamar()).body.trabajo).toBe(true);
      expect((await vinculo()).autoConfirmadoAt).toBe(inicio + 20 * H);
    });

    it("un excluido nunca; un cruce manual tampoco", async () => {
      await sembrar({ id: 1, inicio: inicio - 4 * H, excluido: true }, { id: 2, inicio: inicio - 4 * H });
      await t.DB.prepare("UPDATE matches SET source = 'manual' WHERE id = 'm-2'").run();
      await sinTrabajo();
    });

    it("la consulta de pendientes entra por prode_matches y busca cada partido por su clave", async () => {
      const { sql, params } = consultaPendientes(t.db, AHORA.getTime()).toSQL();
      const { results } = await t.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind(...params).all<{ detail: string }>();
      const plan = results.map((r) => r.detail).join("\n");
      expect(plan).toMatch(/SEARCH matches USING .*(PRIMARY KEY|sqlite_autoindex_matches_1)/);
      expect(plan).not.toMatch(/SCAN matches/);
    });
  });

  describe("con trabajo", () => {
    it("actualiza estado y horario, cierra los pronósticos, guarda lo automático y registra el run", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H });
      publicar(1, { inicio: inicio - 2 * H + 10 * MIN });
      const { status, body } = await llamar();
      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, trabajo: true, status: "success", partidos: 1, competencias: 1, cambios: 1, confirmados: 0 });
      expect(await partido()).toMatchObject({ status: "finished", homeScore: 2, awayScore: 1, dateTime: new Date(inicio - 2 * H + 10 * MIN), round: "Fecha guardada", homeTeamId: "t-16" });
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: 2, autoAwayGoals90: 1, autoRegla: "A", pasadaAt: inicio, closedAt: inicio, homeGoals90: null, pasa: null });
      expect(await runs()).toEqual([expect.objectContaining({ id: body.runId, kind: "prode", trigger: "admin", status: "success", finishedAt: inicio, error: null })]);
      // Solo el año del partido, y sin pedir equipos
      expect(pedidos).toEqual([expect.stringMatching(/\/arg\.1\/scoreboard\?dates=2026&limit=1000/)]);
    });

    it("nunca escribe las columnas manuales", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H });
      await t.DB.prepare("UPDATE prode_matches SET home_goals_90 = 4, away_goals_90 = 4, pasa = 'away'").run();
      publicar(1);
      await llamar();
      expect(await vinculo()).toMatchObject({ homeGoals90: 4, awayGoals90: 4, pasa: "away", autoRegla: "A" });
    });

    it("penales: pide el summary y toma los 90' de los parciales", async () => {
      await sembrar({ id: 1, inicio: inicio - 3 * H });
      publicar(1, PENALES);
      resumen = resumenPenales();
      await llamar();
      expect(pedidos.filter((u) => u.includes("/summary?event=1"))).toHaveLength(1);
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: 0, autoAwayGoals90: 0, autoPasa: "home", autoRegla: "B" });
    });

    it("tope de summaries por invocación, de los más recientes a los más viejos, entre competencias", async () => {
      const casos = [[1, "arg.1", 5], [2, "conmebol.libertadores", 2], [3, "arg.1", 4], [4, "conmebol.sudamericana", 3]] as const;
      await sembrar(...casos.map(([id, liga, horas]) => ({ id, liga, inicio: inicio - horas * H })));
      for (const [id, liga] of casos) publicar(id, PENALES, liga);
      resumen = resumenPenales();
      await llamar();
      expect(pedidos.filter((u) => u.includes("/summary")).map((u) => new URL(u).searchParams.get("event"))).toEqual(["2", "4", "3"]);
    });

    it(`atiende como mucho ${MAX_COMPETENCIAS_PRODE} competencias por invocación; el resto sigue pendiente`, async () => {
      const ligas = ["arg.1", "conmebol.libertadores", "conmebol.sudamericana", "arg.copa"];
      await sembrar(...ligas.map((liga, n) => ({ id: n + 1, liga, inicio: inicio - (2 * H + n * MIN) })));
      ligas.forEach((liga, n) => publicar(n + 1, {}, liga));
      expect((await llamar()).body).toMatchObject({ competencias: 3, partidos: 3 });
      expect(pedidos).toHaveLength(3);
      expect((await vinculo(4)).pasadaAt).toBeNull();

      pedidos = [];
      en(inicio + MIN);
      await llamar();
      expect(pedidos.some((u) => u.includes("/arg.copa/"))).toBe(true);
      expect((await vinculo(4)).pasadaAt).toBe(inicio + MIN);
    });

    it("ESPN caído: run failed, nada escrito y la pasada sigue pendiente", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H });
      publicar(1);
      caidas.add("arg.1");
      const antes = [await partido(), await vinculo()];
      const { status, body } = await llamar();
      expect(status).toBe(500);
      expect(body).toMatchObject({ success: false, trabajo: true, status: "failed" });
      expect([await partido(), await vinculo()]).toEqual(antes);
      expect(await runs()).toEqual([expect.objectContaining({ kind: "prode", status: "failed", error: expect.stringContaining("HTTP 500") })]);

      caidas.clear();
      en(inicio + 15 * MIN);
      expect((await llamar()).body).toMatchObject({ trabajo: true, status: "success" });
    });

    it("un scoreboard sin ningún partido se trata como fuente caída", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H });
      expect((await llamar()).body.status).toBe("failed");
      expect((await vinculo()).pasadaAt).toBeNull();
    });

    it("una competencia caída deja el run partial y no frena a las demás", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H }, { id: 2, inicio: inicio - 2 * H, liga: "conmebol.libertadores" });
      publicar(2, {}, "conmebol.libertadores");
      caidas.add("arg.1");
      expect((await llamar()).body).toMatchObject({ success: true, status: "partial", partidos: 1 });
      expect((await vinculo(1)).pasadaAt).toBeNull();
      expect((await vinculo(2)).pasadaAt).toBe(inicio);
    });

    it("un partido que ESPN no publica queda con la pasada hecha, sin cambios", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H }, { id: 2, inicio: inicio - 2 * H });
      publicar(2);
      expect((await llamar()).body).toMatchObject({ status: "success", partidos: 2, cambios: 1 });
      expect(await partido(1)).toMatchObject({ status: "scheduled" });
      expect((await vinculo(1)).pasadaAt).toBe(inicio);
    });

    it("si falla el batch no queda nada escrito y el run queda failed", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H });
      publicar(1);
      const DB = d1ConCambioAntesDelBatch(t.DB, /prode_matches/, async () => {
        throw new Error("D1 caída");
      });
      expect((await llamar({ DB })).body).toMatchObject({ success: false, status: "failed" });
      expect(await partido()).toMatchObject({ status: "scheduled" });
      expect((await vinculo()).pasadaAt).toBeNull();
      expect(await runs()).toEqual([expect.objectContaining({ status: "failed" })]);
    });

    it("con el KV en off actualiza el partido y marca la pasada, sin datos automáticos", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H });
      publicar(1);
      await kv.put("prode:resultado_auto", "off");
      await llamar();
      expect(await partido()).toMatchObject({ status: "finished" });
      expect(await vinculo()).toMatchObject({ autoRegla: null, autoVistoAt: null, pasadaAt: inicio });
    });

    it("loguea prode_sync con los conteos", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H });
      publicar(1);
      await llamar();
      const logs = (console.log as any).mock.calls.map((c: string[]) => JSON.parse(c[0]));
      expect(logs.find((l: any) => l.msg === "prode_sync")).toMatchObject({ partidos: 1, competencias: 1, cambios: 1, confirmados: 0 });
    });
  });

  // docs/40 §6: suspensiones, correcciones y datos dudosos (sintéticos salvo los estados vistos en el paso 5)
  describe("suspensiones y datos dudosos", () => {
    const pasada = async (o: EventoOpts, previo = "scheduled") => {
      await sembrar({ id: 1, inicio: inicio - 2 * H, status: previo });
      publicar(1, o);
      await llamar();
      return { m: await partido(), v: await vinculo() };
    };
    const SIN_DATO = { autoHomeGoals90: null, autoAwayGoals90: null, autoRegla: null, autoConfirmadoAt: null };

    it("reprogramado con la hora nueva: actualiza la fecha y queda cerrado por la hora original", async () => {
      const nueva = inicio + 48 * H;
      const { m, v } = await pasada({ estado: "STATUS_POSTPONED", state: "pre", inicio: nueva });
      expect(m).toMatchObject({ status: "postponed", dateTime: new Date(nueva) });
      expect(v).toMatchObject({ ...SIN_DATO, closedAt: inicio });
    });

    it("suspendido en juego: cerrado y sin resultado", async () => {
      const { m, v } = await pasada({ estado: "STATUS_SUSPENDED", state: "post" }, "live");
      expect(m.status).toBe("postponed");
      expect(v).toMatchObject({ ...SIN_DATO, closedAt: inicio });
    });

    it("cancelado o abandonado: sin resultado", async () => {
      const { m, v } = await pasada({ estado: "STATUS_ABANDONED", state: "post" });
      expect(m.status).toBe("cancelled");
      expect(v).toMatchObject(SIN_DATO);
    });

    it("resultado administrativo (estado fuera de la lista): sin dato", async () => {
      const { v } = await pasada({ estado: "STATUS_FORFEIT" });
      expect(v).toMatchObject({ ...SIN_DATO, autoPasa: null });
    });

    it("penales sin summary: sin marcador a 90'", async () => {
      const { v } = await pasada(PENALES);
      expect(v).toMatchObject({ autoHomeGoals90: null, autoPasa: "home", autoConfirmadoAt: null });
    });

    it("penales con ganador que no coincide con la tanda: no pasa nadie", async () => {
      const { v } = await pasada({ ...PENALES, winner: "away" });
      expect(v.autoPasa).toBeNull();
    });

    it("una corrección de ESPN reinicia la confirmación", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H });
      publicar(1);
      await llamar();
      publicar(1, { goles: [3, 1] });
      en(inicio + 15 * MIN);
      await llamar();
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: 3, autoVistoAt: inicio + 15 * MIN, autoConfirmadoAt: null });
    });

    it("un finished que vuelve a en vivo deja de tener resultado", async () => {
      await sembrar({ id: 1, inicio: inicio - 2 * H });
      publicar(1);
      await llamar();
      publicar(1, { estado: "STATUS_IN_PROGRESS", state: "in" });
      en(inicio + 15 * MIN);
      await llamar();
      expect((await partido()).status).toBe("live");
      expect(await vinculo()).toMatchObject(SIN_DATO);
    });
  });
});
