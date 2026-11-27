// Puntos del prode (docs/37 §2, §5 y §7): se calculan al leer, desde prode_predictions y matches.
// Corregir un resultado recalcula todo sin duplicar; solo puntúan partidos finished con ambos goles.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { callApi } from "../../helpers/api";
import { silenciarConsola } from "../../helpers/ctx";
import { matches, prodeGroupMembers, prodeGroups, prodeMatches, prodePredictions, users } from "../../../drizzle/schema";
import { puntosPorUsuario } from "../../../src/lib/prode/puntos";
import { GET } from "../../../src/pages/api/prode/mis-puntos";

const AYER = new Date(AHORA.getTime() - DIA_MS);
const MANANA = new Date(AHORA.getTime() + DIA_MS);

describe("puntosPorUsuario", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  relojFijo();

  const cruce = (id: string, round: string, status: string, home: number | null, away: number | null, dateTime = AYER) => ({
    id, externalId: `prode:${id}`, homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league",
    dateTime, status, round, source: "manual", homeScore: home, awayScore: away,
  });
  const pronostico = (userId: string, matchId: string, homeGoals: number, awayGoals: number) =>
    ({ userId, matchId, homeGoals, awayGoals, createdAt: AYER, updatedAt: AYER });

  beforeEach(async () => {
    silenciarConsola(vi);
    fixtures = await seedApp(t.db);
    await t.db.insert(users).values({ id: "user-3", provider: "google", providerId: "provider-3", email: "eva@example.test", name: "Eva" });
    await t.db.insert(matches).values([
      cruce("exacto", "octavos", "finished", 2, 1),
      cruce("empate", "octavos", "finished", 1, 1),
      cruce("cuartos1", "cuartos", "finished", 0, 3),
      cruce("pendiente", "cuartos", "scheduled", null, null, MANANA),
      // Resultado administrativo en un cancelado: no cuenta (docs/37 §5)
      cruce("cancelado", "cuartos", "cancelled", 3, 0),
      cruce("postergado", "cuartos", "postponed", null, null),
      // finished con un solo gol cargado: resultado incompleto, no confirmado
      cruce("incompleto", "semifinal", "finished", 1, null),
    ]);
    // Del prode es lo que está vinculado en prode_matches (la fase sale de ahí)
    const vinculos: Array<[string, string]> = [["exacto", "octavos"], ["empate", "octavos"], ["cuartos1", "cuartos"], ["pendiente", "cuartos"], ["cancelado", "cuartos"], ["postergado", "cuartos"], ["incompleto", "semifinal"]];
    await t.db.insert(prodeMatches).values(vinculos.map(([matchId, fase]) => ({ matchId, fase, createdAt: AYER, ...(matchId === "empate" ? { pasa: "home" } : {}) })));
    await t.db.insert(prodePredictions).values([
      pronostico("user-1", "exacto", 2, 1), // 3, exacto
      pronostico("user-1", "empate", 0, 0), // 1, empate no exacto
      pronostico("user-1", "cuartos1", 1, 0), // 0, fallo
      pronostico("user-1", "pendiente", 1, 0),
      pronostico("user-1", "cancelado", 3, 0),
      pronostico("user-1", "postergado", 1, 1),
      pronostico("user-1", "incompleto", 1, 0),
      pronostico("user-2", "exacto", 3, 0), // 1, ganador
      pronostico("user-2", "cuartos1", 0, 3), // 3, exacto
    ]);
  });

  const de = (r: Awaited<ReturnType<typeof puntosPorUsuario>>, userId: string) => r.usuarios.find((u) => u.userId === userId);

  it("aplica las reglas: exacto 3, ganador 1, empate no exacto 1, fallo 0", async () => {
    const r = await puntosPorUsuario(t.db);
    const p = (userId: string, matchId: string) => r.partidos.find((x) => x.userId === userId && x.matchId === matchId);
    expect(p("user-1", "exacto")).toEqual({ userId: "user-1", matchId: "exacto", fase: "octavos", puntos: 4, marcador: 3, extra: 1, exacto: true, acierto: true });
    expect(p("user-2", "exacto")).toMatchObject({ puntos: 2, marcador: 1, extra: 1, exacto: false, acierto: true });
    expect(p("user-1", "empate")).toMatchObject({ puntos: 1, marcador: 1, extra: 0, exacto: false, acierto: true });
    expect(p("user-1", "cuartos1")).toMatchObject({ puntos: 0, marcador: 0, extra: 0, exacto: false, acierto: false });
    expect(de(r, "user-1")).toEqual({ userId: "user-1", puntos: 5, exactos: 1, aciertos: 2, pasa: 1 });
    expect(de(r, "user-2")).toEqual({ userId: "user-2", puntos: 6, exactos: 1, aciertos: 2, pasa: 2 });
  });

  // docs/40 R3 y R4: el equipo que pasó sale del marcador a 90' si hay ganador; con empate, de prode_matches.pasa
  describe("quién pasa", () => {
    it("un empate terminado sin equipo que pasó no puntúa para nadie (espera completa)", async () => {
      await t.DB.prepare("UPDATE prode_matches SET pasa = NULL WHERE match_id = 'empate'").run();
      const r = await puntosPorUsuario(t.db);
      expect(r.partidos.map((x) => x.matchId)).not.toContain("empate");
      expect(de(r, "user-1")).toEqual({ userId: "user-1", puntos: 4, exactos: 1, aciertos: 1, pasa: 1 });
    });

    it("con ganador, prode_matches.pasa se ignora: pasa el que ganó los 90'", async () => {
      await t.DB.prepare("UPDATE prode_matches SET pasa = 'away' WHERE match_id = 'exacto'").run();
      const r = await puntosPorUsuario(t.db);
      expect(r.partidos.find((x) => x.userId === "user-1" && x.matchId === "exacto")).toMatchObject({ puntos: 4, extra: 1 });
    });

    it("un empate pronosticado con pasa suma el extra solo si coincide con el que pasó", async () => {
      await t.db.insert(prodePredictions).values([
        { ...pronostico("user-3", "empate", 1, 1), pasa: "home" },
        { ...pronostico("user-2", "empate", 1, 1), pasa: "away" },
      ]);
      const r = await puntosPorUsuario(t.db);
      const p = (userId: string) => r.partidos.find((x) => x.userId === userId && x.matchId === "empate");
      expect(p("user-3")).toMatchObject({ puntos: 4, marcador: 3, extra: 1, exacto: true });
      expect(p("user-2")).toMatchObject({ puntos: 3, marcador: 3, extra: 0, exacto: true });
    });

    it("quien solo acierta quién pasa suma 1 punto pero no cuenta como acierto", async () => {
      // Resultado 1-1 y pasa el local; pronóstico 2-0 local: marcador 0, extra 1
      await t.db.insert(prodePredictions).values(pronostico("user-3", "empate", 2, 0));
      const r = await puntosPorUsuario(t.db);
      expect(r.partidos.find((x) => x.userId === "user-3")).toMatchObject({ puntos: 1, marcador: 0, extra: 1, exacto: false, acierto: false });
      expect(de(r, "user-3")).toEqual({ userId: "user-3", puntos: 1, exactos: 0, aciertos: 0, pasa: 1 });
    });

    it("un partido cancelado no da ni el extra", async () => {
      await t.DB.prepare("UPDATE prode_matches SET pasa = 'home' WHERE match_id = 'cancelado'").run();
      expect((await puntosPorUsuario(t.db)).partidos.map((x) => x.matchId)).not.toContain("cancelado");
    });
  });

  it("no puntúan los partidos sin resultado, cancelados, postergados ni con el resultado incompleto", async () => {
    const r = await puntosPorUsuario(t.db);
    const ids = r.partidos.map((x) => x.matchId);
    for (const id of ["pendiente", "cancelado", "postergado", "incompleto"]) expect(ids).not.toContain(id);
  });

  it("sin pronóstico suma 0: un partido sin pronóstico no aparece y el usuario sin pronósticos no aparece", async () => {
    const r = await puntosPorUsuario(t.db);
    expect(r.partidos.filter((x) => x.userId === "user-2").map((x) => x.matchId).sort()).toEqual(["cuartos1", "exacto"]);
    expect(de(r, "user-3")).toBeUndefined();
  });

  it("corregir un resultado cambia los puntos sin duplicarlos", async () => {
    await t.DB.prepare("UPDATE matches SET home_score = 1, away_score = 0 WHERE id = 'exacto'").run();
    const r = await puntosPorUsuario(t.db);
    expect(r.partidos.filter((x) => x.userId === "user-1" && x.matchId === "exacto")).toHaveLength(1);
    expect(de(r, "user-1")).toEqual({ userId: "user-1", puntos: 3, exactos: 0, aciertos: 2, pasa: 1 });
    expect(de(r, "user-2")).toEqual({ userId: "user-2", puntos: 6, exactos: 1, aciertos: 2, pasa: 2 });

    // Si el partido deja de estar terminado (por ejemplo, se anula), deja de puntuar
    await t.DB.prepare("UPDATE matches SET status = 'cancelled' WHERE id = 'cuartos1'").run();
    expect(de(await puntosPorUsuario(t.db), "user-2")).toEqual({ userId: "user-2", puntos: 2, exactos: 0, aciertos: 1, pasa: 1 });
  });

  it("filtra por fase", async () => {
    const r = await puntosPorUsuario(t.db, { fase: "cuartos" });
    expect(r.partidos.map((x) => x.matchId)).toEqual(["cuartos1", "cuartos1"]);
    expect(de(r, "user-1")).toEqual({ userId: "user-1", puntos: 0, exactos: 0, aciertos: 0, pasa: 0 });
    expect(de(r, "user-2")).toEqual({ userId: "user-2", puntos: 4, exactos: 1, aciertos: 1, pasa: 1 });
  });

  it("filtra por grupo: solo sus miembros, y quien se suma sin pronósticos parte en 0", async () => {
    await t.db.insert(prodeGroups).values({ id: "g1", name: "Amigos", inviteCode: "ABC123", ownerId: "user-1", createdAt: AHORA.getTime() });
    await t.db.insert(prodeGroupMembers).values([
      { groupId: "g1", userId: "user-1", joinedAt: AHORA.getTime() },
      { groupId: "g1", userId: "user-3", joinedAt: AHORA.getTime() },
    ]);
    const r = await puntosPorUsuario(t.db, { grupoId: "g1" });
    expect(r.usuarios).toEqual([
      { userId: "user-1", puntos: 5, exactos: 1, aciertos: 2, pasa: 1 },
      { userId: "user-3", puntos: 0, exactos: 0, aciertos: 0, pasa: 0 },
    ]);
    expect(r.partidos.every((x) => x.userId === "user-1")).toBe(true);
    expect((await puntosPorUsuario(t.db, { grupoId: "inexistente" })).usuarios).toEqual([]);
  });

  it("filtra por usuario: solo los propios, y en 0 si todavía no puntuó", async () => {
    const r = await puntosPorUsuario(t.db, { userId: "user-2" });
    expect(r.usuarios).toEqual([{ userId: "user-2", puntos: 6, exactos: 1, aciertos: 2, pasa: 2 }]);
    expect(r.partidos.every((x) => x.userId === "user-2")).toBe(true);
    expect((await puntosPorUsuario(t.db, { userId: "user-3" })).usuarios).toEqual([{ userId: "user-3", puntos: 0, exactos: 0, aciertos: 0, pasa: 0 }]);
  });

  // docs/37 §2: el marcador de ESPN puede incluir alargue o penales; un adoptado puntúa solo con el
  // resultado a 90' confirmado por el admin (prode_matches.home_goals_90/away_goals_90)
  it("un adoptado de ESPN puntúa solo con el resultado a 90 confirmado, no con el marcador de ESPN", async () => {
    await t.db.insert(matches).values({ ...cruce("espn-1", "Quarterfinals", "finished", 3, 2), externalId: "espn:1", source: "espn" });
    await t.db.insert(prodeMatches).values({ matchId: "espn-1", fase: "cuartos", createdAt: AYER });
    await t.db.insert(prodePredictions).values(pronostico("user-3", "espn-1", 3, 2));
    // Sin resultado a 90: queda a la espera aunque ESPN lo dé por terminado
    expect(de(await puntosPorUsuario(t.db), "user-3")).toBeUndefined();

    await t.DB.prepare("UPDATE prode_matches SET home_goals_90 = 2, away_goals_90 = 2 WHERE match_id = 'espn-1'").run();
    // Empate a 90' sin equipo que pasó: sigue en espera (docs/40 R4)
    expect(de(await puntosPorUsuario(t.db), "user-3")).toBeUndefined();
    await t.DB.prepare("UPDATE prode_matches SET pasa = 'home' WHERE match_id = 'espn-1'").run();
    expect(de(await puntosPorUsuario(t.db), "user-3")).toEqual({ userId: "user-3", puntos: 1, exactos: 0, aciertos: 0, pasa: 1 });
    await t.DB.prepare("UPDATE prode_predictions SET home_goals = 2, away_goals = 2, pasa = 'home' WHERE user_id = 'user-3'").run();
    expect(de(await puntosPorUsuario(t.db), "user-3")).toEqual({ userId: "user-3", puntos: 4, exactos: 1, aciertos: 1, pasa: 1 });

    // Con el resultado a 90 cargado pero el partido sin terminar, no puntúa
    await t.DB.prepare("UPDATE matches SET status = 'live' WHERE id = 'espn-1'").run();
    expect(de(await puntosPorUsuario(t.db), "user-3")).toBeUndefined();
  });

  it("ignora los partidos que no son del prode", async () => {
    await t.DB.prepare("UPDATE matches SET status = 'finished', home_score = 1, away_score = 0 WHERE id = 'superclasico'").run();
    await t.db.insert(prodePredictions).values(pronostico("user-3", "superclasico", 1, 0));
    expect(de(await puntosPorUsuario(t.db), "user-3")).toBeUndefined();
  });

  it("puntúa un partido de ESPN adoptado con su resultado a 90 y la fase del vínculo", async () => {
    await t.DB.prepare("UPDATE matches SET status = 'finished', home_score = 1, away_score = 0, date_time = ? WHERE id = 'superclasico'").bind(Math.floor(AYER.getTime() / 1000)).run();
    await t.db.insert(prodeMatches).values({ matchId: "superclasico", fase: "final", createdAt: AYER, homeGoals90: 1, awayGoals90: 0 });
    await t.db.insert(prodePredictions).values(pronostico("user-3", "superclasico", 1, 0));
    const r = await puntosPorUsuario(t.db, { fase: "final" });
    expect(r.partidos).toEqual([{ userId: "user-3", matchId: "superclasico", fase: "final", puntos: 4, marcador: 3, extra: 1, exacto: true, acierto: true }]);
  });

  it("un cruce manual sin vínculo no puntúa", async () => {
    await t.DB.prepare("DELETE FROM prode_matches WHERE match_id = 'exacto'").run();
    expect((await puntosPorUsuario(t.db)).partidos.map((x) => x.matchId)).not.toContain("exacto");
  });

  describe("GET /api/prode/mis-puntos", () => {
    it("sin sesión responde 401", async () => {
      expect((await callApi(GET, t.DB)).status).toBe(401);
    });

    it("devuelve solo los puntos propios", async () => {
      const res = await callApi(GET, t.DB, { user: fixtures.other });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({ puntos: 6, exactos: 1, aciertos: 2 });
      expect(body.partidos.map((x: any) => x.matchId).sort()).toEqual(["cuartos1", "exacto"]);
      expect(JSON.stringify(body)).not.toContain("user-1");
    });

    it("filtra por fase y rechaza una fase inválida", async () => {
      const ok = (await (await callApi(GET, t.DB, { user: fixtures.other, path: "/api/prode/mis-puntos?fase=octavos" })).json()) as any;
      expect(ok).toMatchObject({ puntos: 2, exactos: 0, aciertos: 1 });
      expect(ok.partidos).toEqual([{ matchId: "exacto", fase: "octavos", puntos: 2, marcador: 1, extra: 1, exacto: false, acierto: true }]);
      expect((await callApi(GET, t.DB, { user: fixtures.other, path: "/api/prode/mis-puntos?fase=grupos" })).status).toBe(400);
    });
  });
});

// docs/40 D2 y D3: precedencia excluido > manual > automático confirmado, por par, y el apagado total
describe("puntosPorUsuario con resultado automático (docs/40 D2)", () => {
  const t = useTestDb();
  relojFijo();
  const CONFIRMADO = AYER.getTime();

  type Vinculo = Partial<typeof prodeMatches.$inferInsert>;
  const adoptado = async (id: string, vinculo: Vinculo, status = "finished") => {
    await t.db.insert(matches).values({
      id, externalId: `espn:${id}`, homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league",
      dateTime: AYER, status, round: "cuartos", source: "espn", homeScore: 2, awayScore: 2,
    });
    await t.db.insert(prodeMatches).values({ matchId: id, fase: "cuartos", createdAt: AYER, ...vinculo });
  };
  const auto = (local: number | null, visitante: number | null, pasa: "home" | "away" | null, confirmado: number | null = CONFIRMADO): Vinculo => ({
    autoHomeGoals90: local, autoAwayGoals90: visitante, autoPasa: pasa, autoRegla: "A", autoVistoAt: AYER.getTime(), autoConfirmadoAt: confirmado,
  });
  const pronostico = (matchId: string, homeGoals: number, awayGoals: number, pasa: "home" | "away" | null = null) =>
    ({ userId: "user-1", matchId, homeGoals, awayGoals, pasa, createdAt: AYER, updatedAt: AYER });
  const puntos = async (autoHabilitado?: boolean) => (await puntosPorUsuario(t.db, {}, autoHabilitado)).partidos;

  beforeEach(async () => {
    silenciarConsola(vi);
    await seedApp(t.db);
  });

  it("un automático confirmado puntúa marcador y quién pasa (ganador derivado)", async () => {
    await adoptado("a1", auto(2, 1, "home"));
    await t.db.insert(prodePredictions).values(pronostico("a1", 2, 1));
    expect(await puntos()).toEqual([expect.objectContaining({ matchId: "a1", marcador: 3, extra: 1, puntos: 4 })]);
  });

  it("un automático sin confirmar no puntúa", async () => {
    await adoptado("a1", auto(2, 1, "home", null));
    await t.db.insert(prodePredictions).values(pronostico("a1", 2, 1));
    expect(await puntos()).toEqual([]);
  });

  it("empate automático confirmado: quién pasa sale de auto_pasa", async () => {
    await adoptado("a1", auto(1, 1, "away"));
    await t.db.insert(prodePredictions).values(pronostico("a1", 1, 1, "away"));
    expect(await puntos()).toEqual([expect.objectContaining({ marcador: 3, extra: 1 })]);
  });

  it("empate automático sin quién pasa: espera completa", async () => {
    await adoptado("a1", auto(1, 1, null));
    await t.db.insert(prodePredictions).values(pronostico("a1", 1, 1, "home"));
    expect(await puntos()).toEqual([]);
  });

  it("la corrección manual completa gana sobre el automático confirmado", async () => {
    await adoptado("a1", { ...auto(2, 1, "home"), homeGoals90: 0, awayGoals90: 1 });
    await t.db.insert(prodePredictions).values(pronostico("a1", 0, 1));
    expect(await puntos()).toEqual([expect.objectContaining({ marcador: 3, extra: 1 })]);
  });

  it("nunca mezcla un gol manual con uno automático: un par manual incompleto no se usa y vale el automático", async () => {
    await adoptado("a1", { ...auto(2, 1, "home"), homeGoals90: 5, awayGoals90: null });
    await t.db.insert(prodePredictions).values(pronostico("a1", 2, 1));
    expect(await puntos()).toEqual([expect.objectContaining({ marcador: 3 })]);
    // y sin automático confirmado, un par manual incompleto no puntúa
    await t.DB.prepare("UPDATE prode_matches SET auto_confirmado_at = NULL WHERE match_id = 'a1'").run();
    expect(await puntos()).toEqual([]);
  });

  it("pasa manual gana sobre auto_pasa en un empate", async () => {
    await adoptado("a1", { ...auto(1, 1, "away"), pasa: "home" });
    await t.db.insert(prodePredictions).values(pronostico("a1", 1, 1, "home"));
    expect(await puntos()).toEqual([expect.objectContaining({ extra: 1 })]);
  });

  it("un partido excluido no puntúa aunque tenga manual y automático", async () => {
    await adoptado("a1", { ...auto(2, 1, "home"), homeGoals90: 2, awayGoals90: 1, excludedAt: CONFIRMADO });
    await t.db.insert(prodePredictions).values(pronostico("a1", 2, 1));
    expect(await puntos()).toEqual([]);
  });

  it("con el automático apagado (PRODE_RESULTADO_AUTO=off) ignora incluso lo confirmado, pero no lo manual", async () => {
    await adoptado("a1", auto(2, 1, "home"));
    await adoptado("a2", { ...auto(2, 1, "home"), homeGoals90: 2, awayGoals90: 1 });
    await t.db.insert(prodePredictions).values([pronostico("a1", 2, 1), pronostico("a2", 2, 1)]);
    expect((await puntos(false)).map((p) => p.matchId)).toEqual(["a2"]);
    expect((await puntos(true)).map((p) => p.matchId).sort()).toEqual(["a1", "a2"]);
  });

  it("el automático no puntúa si el partido no está finished", async () => {
    await adoptado("a1", auto(2, 1, "home"), "live");
    await t.db.insert(prodePredictions).values(pronostico("a1", 2, 1));
    expect(await puntos()).toEqual([]);
  });

  it("un cruce manual sigue usando matches.home_score aunque tenga columnas automáticas", async () => {
    await t.db.insert(matches).values({
      id: "m1", externalId: "prode:m1", homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league",
      dateTime: AYER, status: "finished", round: "cuartos", source: "manual", homeScore: 0, awayScore: 3,
    });
    await t.db.insert(prodeMatches).values({ matchId: "m1", fase: "cuartos", createdAt: AYER, ...auto(2, 1, "home") });
    await t.db.insert(prodePredictions).values(pronostico("m1", 0, 3));
    expect(await puntos()).toEqual([expect.objectContaining({ marcador: 3, extra: 1 })]);
  });
});
