// Puntos del prode (docs/37 §2, §5 y §7): se calculan al leer, desde prode_predictions y matches.
// Corregir un resultado recalcula todo sin duplicar; solo puntúan partidos finished con ambos goles.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { callApi } from "../../helpers/api";
import { silenciarConsola } from "../../helpers/ctx";
import { matches, prodeGroupMembers, prodeGroups, prodePredictions, users } from "../../../drizzle/schema";
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
    expect(p("user-1", "exacto")).toEqual({ userId: "user-1", matchId: "exacto", fase: "octavos", puntos: 3, exacto: true, acierto: true });
    expect(p("user-2", "exacto")).toMatchObject({ puntos: 1, exacto: false, acierto: true });
    expect(p("user-1", "empate")).toMatchObject({ puntos: 1, exacto: false, acierto: true });
    expect(p("user-1", "cuartos1")).toMatchObject({ puntos: 0, exacto: false, acierto: false });
    expect(de(r, "user-1")).toEqual({ userId: "user-1", puntos: 4, exactos: 1, aciertos: 2 });
    expect(de(r, "user-2")).toEqual({ userId: "user-2", puntos: 4, exactos: 1, aciertos: 2 });
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
    await t.DB.prepare("UPDATE matches SET home_score = 0, away_score = 0 WHERE id = 'exacto'").run();
    const r = await puntosPorUsuario(t.db);
    expect(r.partidos.filter((x) => x.userId === "user-1" && x.matchId === "exacto")).toHaveLength(1);
    expect(de(r, "user-1")).toEqual({ userId: "user-1", puntos: 1, exactos: 0, aciertos: 1 });
    expect(de(r, "user-2")).toEqual({ userId: "user-2", puntos: 3, exactos: 1, aciertos: 1 });

    // Si el partido deja de estar terminado (por ejemplo, se anula), deja de puntuar
    await t.DB.prepare("UPDATE matches SET status = 'cancelled' WHERE id = 'cuartos1'").run();
    expect(de(await puntosPorUsuario(t.db), "user-2")).toEqual({ userId: "user-2", puntos: 0, exactos: 0, aciertos: 0 });
  });

  it("filtra por fase", async () => {
    const r = await puntosPorUsuario(t.db, { fase: "cuartos" });
    expect(r.partidos.map((x) => x.matchId)).toEqual(["cuartos1", "cuartos1"]);
    expect(de(r, "user-1")).toEqual({ userId: "user-1", puntos: 0, exactos: 0, aciertos: 0 });
    expect(de(r, "user-2")).toEqual({ userId: "user-2", puntos: 3, exactos: 1, aciertos: 1 });
  });

  it("filtra por grupo: solo sus miembros, y quien se suma sin pronósticos parte en 0", async () => {
    await t.db.insert(prodeGroups).values({ id: "g1", name: "Amigos", inviteCode: "ABC123", ownerId: "user-1", createdAt: AHORA.getTime() });
    await t.db.insert(prodeGroupMembers).values([
      { groupId: "g1", userId: "user-1", joinedAt: AHORA.getTime() },
      { groupId: "g1", userId: "user-3", joinedAt: AHORA.getTime() },
    ]);
    const r = await puntosPorUsuario(t.db, { grupoId: "g1" });
    expect(r.usuarios).toEqual([
      { userId: "user-1", puntos: 4, exactos: 1, aciertos: 2 },
      { userId: "user-3", puntos: 0, exactos: 0, aciertos: 0 },
    ]);
    expect(r.partidos.every((x) => x.userId === "user-1")).toBe(true);
    expect((await puntosPorUsuario(t.db, { grupoId: "inexistente" })).usuarios).toEqual([]);
  });

  it("filtra por usuario: solo los propios, y en 0 si todavía no puntuó", async () => {
    const r = await puntosPorUsuario(t.db, { userId: "user-2" });
    expect(r.usuarios).toEqual([{ userId: "user-2", puntos: 4, exactos: 1, aciertos: 2 }]);
    expect(r.partidos.every((x) => x.userId === "user-2")).toBe(true);
    expect((await puntosPorUsuario(t.db, { userId: "user-3" })).usuarios).toEqual([{ userId: "user-3", puntos: 0, exactos: 0, aciertos: 0 }]);
  });

  it("ignora los partidos que no son del prode", async () => {
    await t.DB.prepare("UPDATE matches SET status = 'finished', home_score = 1, away_score = 0 WHERE id = 'superclasico'").run();
    await t.db.insert(prodePredictions).values(pronostico("user-3", "superclasico", 1, 0));
    expect(de(await puntosPorUsuario(t.db), "user-3")).toBeUndefined();
  });

  describe("GET /api/prode/mis-puntos", () => {
    it("sin sesión responde 401", async () => {
      expect((await callApi(GET, t.DB)).status).toBe(401);
    });

    it("devuelve solo los puntos propios", async () => {
      const res = await callApi(GET, t.DB, { user: fixtures.other });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body).toMatchObject({ puntos: 4, exactos: 1, aciertos: 2 });
      expect(body.partidos.map((x: any) => x.matchId).sort()).toEqual(["cuartos1", "exacto"]);
      expect(JSON.stringify(body)).not.toContain("user-1");
    });

    it("filtra por fase y rechaza una fase inválida", async () => {
      const ok = (await (await callApi(GET, t.DB, { user: fixtures.other, path: "/api/prode/mis-puntos?fase=octavos" })).json()) as any;
      expect(ok).toMatchObject({ puntos: 1, exactos: 0, aciertos: 1 });
      expect((await callApi(GET, t.DB, { user: fixtures.other, path: "/api/prode/mis-puntos?fase=grupos" })).status).toBe(400);
    });
  });
});
