// GET/PUT /api/prode/pronosticos: carga y edición de pronósticos, con cierre en el inicio del partido.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { callApi } from "../../helpers/api";
import { silenciarConsola } from "../../helpers/ctx";
import { matches, prodeMatches } from "../../../drizzle/schema";
import { GET, PUT } from "../../../src/pages/api/prode/pronosticos";
import { guardarPronostico, validarMarcador } from "../../../src/lib/prode/pronosticos";
import { createDb } from "../../../src/lib/db";

const INICIO = new Date(AHORA.getTime() + DIA_MS);

describe("validarMarcador", () => {
  it("acepta enteros de 0 a 20 y rechaza el resto", () => {
    expect(validarMarcador(0, 20)).toEqual({ homeGoals: 0, awayGoals: 20 });
    for (const [l, v] of [[-1, 0], [21, 0], [1.5, 0], ["2", 1], [null, 1], [1, undefined]] as const) {
      expect(validarMarcador(l, v)).toBeNull();
    }
  });
});

describe("/api/prode/pronosticos", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  relojFijo();

  beforeEach(async () => {
    silenciarConsola(vi);
    fixtures = await seedApp(t.db);
    // Cruces del prode: uno por jugarse, uno ya jugado. "superclasico" (de seedApp) no es del prode.
    await t.db.insert(matches).values([
      { id: "p1", externalId: "prode:p1", homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league", dateTime: INICIO, status: "scheduled", round: "cuartos", source: "manual" },
      { id: "p0", externalId: "prode:p0", homeTeamId: "boca", awayTeamId: "river", leagueId: "test-league", dateTime: new Date(AHORA.getTime() - DIA_MS), status: "finished", round: "octavos", source: "manual" },
    ]);
    await t.db.insert(prodeMatches).values([
      { matchId: "p1", fase: "cuartos", createdAt: AHORA },
      { matchId: "p0", fase: "octavos", createdAt: AHORA },
    ]);
  });

  it("un partido de ESPN adoptado se lista y se pronostica", async () => {
    await t.db.insert(prodeMatches).values({ matchId: "superclasico", fase: "semifinal", createdAt: AHORA });
    const res = await put({ matchId: "superclasico", homeGoals: 1, awayGoals: 1, pasa: "home" });
    expect(res.status).toBe(200);
    const { partidos } = await get();
    expect(partidos.find((p: any) => p.id === "superclasico")).toMatchObject({ fase: "semifinal", estado: "abierto", pronostico: { homeGoals: 1, awayGoals: 1, pasa: "home" } });
  });

  it("un cruce manual sin vínculo no se lista ni se pronostica", async () => {
    await t.DB.prepare("DELETE FROM prode_matches WHERE match_id = 'p1'").run();
    expect((await put({ matchId: "p1", homeGoals: 1, awayGoals: 0 })).status).toBe(404);
    expect((await get()).partidos.map((p: any) => p.id)).toEqual(["p0"]);
  });

  const put = (body: unknown, user = fixtures.user) => callApi(PUT, t.DB, { user, method: "PUT", body });
  const get = async (user = fixtures.user) => (await (await callApi(GET, t.DB, { user })).json()) as any;
  const fila = (userId: string, matchId: string) =>
    t.DB.prepare("SELECT * FROM prode_predictions WHERE user_id = ? AND match_id = ?").bind(userId, matchId).first<any>();

  it("sin sesión responde 401", async () => {
    expect((await callApi(GET, t.DB)).status).toBe(401);
    expect((await callApi(PUT, t.DB, { method: "PUT", body: { matchId: "p1", homeGoals: 1, awayGoals: 0 } })).status).toBe(401);
  });

  it("GET muestra los partidos del prode con fase, cierre y estado", async () => {
    const { partidos } = await get();
    expect(partidos.map((p: any) => p.id)).toEqual(["p0", "p1"]);
    expect(partidos[1]).toMatchObject({ fase: "cuartos", faseEtiqueta: "Cuartos de final", cierre: INICIO.toISOString(), estado: "abierto", pronostico: null });
    expect(partidos[0]).toMatchObject({ estado: "jugado" });
  });

  it("guarda y modifica el pronóstico antes del inicio (UPSERT)", async () => {
    const res = await put({ matchId: "p1", homeGoals: 2, awayGoals: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ pronostico: { matchId: "p1", homeGoals: 2, awayGoals: 1, pasa: null } });

    vi.setSystemTime(INICIO.getTime() - 1);
    expect((await put({ matchId: "p1", homeGoals: 0, awayGoals: 0, pasa: "away" })).status).toBe(200);
    expect(await fila("user-1", "p1")).toMatchObject({ home_goals: 0, away_goals: 0 });
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM prode_predictions").first<any>()).n).toBe(1);

    const { partidos } = await get();
    expect(partidos.find((p: any) => p.id === "p1").pronostico).toEqual({ homeGoals: 0, awayGoals: 0, pasa: "away" });
    // Cada usuario ve solo lo suyo
    expect((await get(fixtures.other)).partidos.find((p: any) => p.id === "p1").pronostico).toBeNull();
  });

  describe("quién pasa (docs/40 R2)", () => {
    it("un empate sin pasa responde 400 falta_quien_pasa y no guarda nada", async () => {
      for (const extra of [{}, { pasa: null }, { pasa: "empate" }, { pasa: 1 }]) {
        const res = await put({ matchId: "p1", homeGoals: 1, awayGoals: 1, ...extra });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "falta_quien_pasa" });
      }
      expect(await fila("user-1", "p1")).toBeNull();
    });

    it("un partido cerrado responde 409 pronostico_cerrado aunque falte pasa (el cierre se mira primero)", async () => {
      vi.setSystemTime(INICIO);
      const res = await put({ matchId: "p1", homeGoals: 1, awayGoals: 1 });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "pronostico_cerrado" });
      expect(await fila("user-1", "p1")).toBeNull();
    });

    it("un empate con pasa lo guarda y lo devuelve en PUT y GET", async () => {
      const res = await put({ matchId: "p1", homeGoals: 2, awayGoals: 2, pasa: "away" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pronostico: { matchId: "p1", homeGoals: 2, awayGoals: 2, pasa: "away" } });
      expect(await fila("user-1", "p1")).toMatchObject({ pasa: "away" });
      expect((await get()).partidos.find((p: any) => p.id === "p1").pronostico).toEqual({ homeGoals: 2, awayGoals: 2, pasa: "away" });
    });

    it("con un ganador, pasa se ignora y se guarda null (aunque venga inválido)", async () => {
      const res = await put({ matchId: "p1", homeGoals: 2, awayGoals: 1, pasa: "away" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).pronostico.pasa).toBeNull();
      expect(await fila("user-1", "p1")).toMatchObject({ pasa: null });
      expect((await put({ matchId: "p1", homeGoals: 0, awayGoals: 1, pasa: "cualquiera" })).status).toBe(200);
    });

    it("cambiar de 1-1 a 2-1 limpia pasa; cambiar de 2-1 a 1-1 lo exige", async () => {
      await put({ matchId: "p1", homeGoals: 1, awayGoals: 1, pasa: "home" });
      expect(await fila("user-1", "p1")).toMatchObject({ pasa: "home" });
      await put({ matchId: "p1", homeGoals: 2, awayGoals: 1 });
      expect(await fila("user-1", "p1")).toMatchObject({ home_goals: 2, pasa: null });
      expect((await put({ matchId: "p1", homeGoals: 1, awayGoals: 1 })).status).toBe(400);
      expect(await fila("user-1", "p1")).toMatchObject({ home_goals: 2, pasa: null });
    });

    it("el cierre atómico sigue rigiendo con pasa", async () => {
      await put({ matchId: "p1", homeGoals: 1, awayGoals: 1, pasa: "home" });
      vi.setSystemTime(INICIO);
      const res = await put({ matchId: "p1", homeGoals: 3, awayGoals: 3, pasa: "away" });
      expect(res.status).toBe(409);
      expect(await fila("user-1", "p1")).toMatchObject({ home_goals: 1, pasa: "home" });
    });

    it("un pronóstico anterior a la 0022 (sin pasa) se lee con pasa null", async () => {
      await t.DB.prepare("INSERT INTO prode_predictions (user_id, match_id, home_goals, away_goals, created_at, updated_at) VALUES ('user-1', 'p1', 1, 1, 1, 1)").run();
      expect((await get()).partidos.find((p: any) => p.id === "p1").pronostico).toEqual({ homeGoals: 1, awayGoals: 1, pasa: null });
    });
  });

  it("rechaza con 409 pronostico_cerrado desde el instante exacto del inicio", async () => {
    await put({ matchId: "p1", homeGoals: 2, awayGoals: 1 });
    vi.setSystemTime(INICIO);
    const res = await put({ matchId: "p1", homeGoals: 3, awayGoals: 3, pasa: "home" });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "pronostico_cerrado" });
    expect(await fila("user-1", "p1")).toMatchObject({ home_goals: 2, away_goals: 1 });
    expect((await get()).partidos.find((p: any) => p.id === "p1").estado).toBe("cerrado");
  });

  it.each(["live", "cancelled", "finished"])("rechaza con 409 si el partido está %s aunque su hora sea futura", async (status) => {
    await t.DB.prepare("UPDATE matches SET status = ? WHERE id = 'p1'").bind(status).run();
    const res = await put({ matchId: "p1", homeGoals: 1, awayGoals: 0 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "pronostico_cerrado" });
    expect(await fila("user-1", "p1")).toBeNull();
  });

  it("un envío tardío no se salva con una hora del cliente", async () => {
    vi.setSystemTime(INICIO.getTime() + 60_000);
    const res = await put({ matchId: "p1", homeGoals: 1, awayGoals: 0, ahora: AHORA.toISOString(), enviadoEn: AHORA.getTime() });
    expect(res.status).toBe(409);
    expect(await fila("user-1", "p1")).toBeNull();
  });

  // D1 que, justo antes de escribir el pronóstico, aplica `cambio`: simula que el partido cambia entre
  // la lectura y la escritura (pedido demorado). El cierre tiene que decidirse en la misma sentencia.
  const d1ConCambioAlEscribir = (cambio: () => Promise<unknown>): D1Database =>
    new Proxy(t.DB, {
      get(target, prop) {
        if (prop !== "prepare") return Reflect.get(target, prop).bind?.(target) ?? Reflect.get(target, prop);
        return (query: string) => {
          const stmt = target.prepare(query);
          if (!/insert into\s+"?prode_predictions/i.test(query)) return stmt;
          const envolver = (s: D1PreparedStatement): D1PreparedStatement =>
            new Proxy(s, {
              get(st, p) {
                if (p === "bind") return (...args: unknown[]) => envolver(st.bind(...args));
                if (p === "run" || p === "all" || p === "raw" || p === "first")
                  return async (...args: unknown[]) => {
                    await cambio();
                    return (st as any)[p](...args);
                  };
                return Reflect.get(st, p);
              },
            });
          return envolver(stmt);
        };
      },
    });

  it.each([
    ["pasa a live", () => t.DB.prepare("UPDATE matches SET status = 'live' WHERE id = 'p1'").run()],
    ["se adelanta al pasado", () => t.DB.prepare("UPDATE matches SET date_time = ? WHERE id = 'p1'").bind(Math.floor((AHORA.getTime() - 60_000) / 1000)).run()],
  ])("rechaza con 409 si el partido %s entre la lectura y la escritura", async (_, cambio) => {
    const db = createDb(d1ConCambioAlEscribir(cambio));
    const res = await guardarPronostico(db, "user-1", { matchId: "p1", homeGoals: 1, awayGoals: 0 });
    expect(res).toEqual({ ok: false, status: 409, error: "pronostico_cerrado" });
    expect(await fila("user-1", "p1")).toBeNull();
  });

  it("un pedido demorado no modifica un pronóstico existente después del cierre", async () => {
    await put({ matchId: "p1", homeGoals: 2, awayGoals: 1 });
    const db = createDb(d1ConCambioAlEscribir(() => t.DB.prepare("UPDATE matches SET status = 'live' WHERE id = 'p1'").run()));
    const res = await guardarPronostico(db, "user-1", { matchId: "p1", homeGoals: 3, awayGoals: 3, pasa: "home" });
    expect(res).toMatchObject({ ok: false, status: 409 });
    expect(await fila("user-1", "p1")).toMatchObject({ home_goals: 2, away_goals: 1 });
  });

  it("valida el marcador y el partido", async () => {
    for (const body of [{ matchId: "p1", homeGoals: 21, awayGoals: 0 }, { matchId: "p1", homeGoals: -1, awayGoals: 0 }, { matchId: "p1", homeGoals: 1.5, awayGoals: 0 }, { homeGoals: 1, awayGoals: 0 }]) {
      expect((await put(body)).status).toBe(400);
    }
    expect((await callApi(PUT, t.DB, { user: fixtures.user, method: "PUT", rawBody: "{no es json" })).status).toBe(400);
    expect((await put({ matchId: "no-existe", homeGoals: 1, awayGoals: 0 })).status).toBe(404);
    // Un partido que no es del prode no se pronostica
    expect((await put({ matchId: "superclasico", homeGoals: 1, awayGoals: 0 })).status).toBe(404);
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM prode_predictions").first<any>()).n).toBe(0);
  });
});
