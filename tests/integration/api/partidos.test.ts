import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, HORA_MS, relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { callApi } from "../../helpers/api";
import { silenciarConsola } from "../../helpers/ctx";
import { calendarSyncs, leagues, matches, teams, userTeams } from "../../../drizzle/schema";
import { GET } from "../../../src/pages/api/partidos/index";

describe("GET /api/partidos", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  relojFijo();

  beforeEach(async () => {
    silenciarConsola(vi);
    fixtures = await seedApp(t.db);
    await t.db.delete(matches); // cada test siembra sus propios partidos
    // Liga y equipo ajenos a lo que sigue el usuario
    await t.db.insert(leagues).values({ id: "otra-liga", externalId: "test:otra", name: "Liga Española", country: "España", season: 2026 });
    await t.db.insert(teams).values({ id: "madrid", externalId: "test:madrid", name: "Real Madrid", leagueId: "otra-liga" });
  });

  const seguir = (teamId: string, userId = fixtures.user.id) => t.db.insert(userTeams).values({ userId, teamId });
  const partido = (id: string, o: { home?: string; away?: string; league?: string; horas?: number } = {}) =>
    t.db.insert(matches).values({
      id,
      externalId: `ext-${id}`,
      homeTeamId: o.home ?? "river",
      awayTeamId: o.away ?? "boca",
      leagueId: o.league ?? "test-league",
      dateTime: new Date(AHORA.getTime() + (o.horas ?? 1) * HORA_MS),
    });
  const llamar = async (query = "", user: typeof fixtures.user | null = fixtures.user) => {
    const res = await callApi(GET, t.DB, { user: user ?? undefined, path: `/api/partidos${query}` });
    return { res, body: (await res.clone().json()) as any };
  };
  const ids = (body: any[]) => body.map((p) => p.id);

  it("sin sesión responde 401", async () => {
    expect((await llamar("", null)).res.status).toBe(401);
  });

  it("si no sigue ningún equipo devuelve una lista vacía", async () => {
    await partido("m1");
    expect((await llamar()).body).toEqual([]);
  });

  it("devuelve los próximos partidos de los equipos seguidos ordenados por fecha", async () => {
    await seguir("river");
    await partido("tarde", { horas: 5 });
    await partido("temprano", { horas: 1 });
    expect(ids((await llamar()).body)).toEqual(["temprano", "tarde"]);
  });

  it("no incluye partidos de equipos que no sigue", async () => {
    await seguir("river");
    await partido("ajeno", { home: "madrid", away: "madrid", league: "otra-liga" });
    expect((await llamar()).body).toEqual([]);
  });

  it("incluye el partido si el equipo seguido juega de visitante", async () => {
    await seguir("boca");
    await partido("m1", { home: "river", away: "boca" });
    expect(ids((await llamar()).body)).toEqual(["m1"]);
  });

  it("excluye los partidos pasados", async () => {
    await seguir("river");
    await partido("pasado", { horas: -1 });
    expect((await llamar()).body).toEqual([]);
  });

  it("incluye el partido que empieza justo ahora", async () => {
    await seguir("river");
    await partido("ahora", { horas: 0 });
    expect(ids((await llamar()).body)).toEqual(["ahora"]);
  });

  describe("teamId", () => {
    beforeEach(async () => {
      await seguir("river");
      await seguir("madrid");
      await partido("bocaRiver", { home: "river", away: "boca" });
      await partido("madrid", { home: "madrid", away: "madrid", league: "otra-liga", horas: 2 });
    });

    it("filtra por el equipo indicado", async () => {
      expect(ids((await llamar("?teamId=madrid")).body)).toEqual(["madrid"]);
    });

    it("sin filtro devuelve los de todos los equipos seguidos", async () => {
      expect(ids((await llamar()).body)).toEqual(["bocaRiver", "madrid"]);
    });
  });

  describe("limit", () => {
    const sembrarPartidos = async (n: number) => {
      await seguir("river");
      for (let i = 1; i <= n; i++) await partido(`m${i}`, { horas: i });
    };

    it("respeta el valor indicado", async () => {
      await sembrarPartidos(5);
      expect(ids((await llamar("?limit=2")).body)).toEqual(["m1", "m2"]);
    });

    it("sin valor usa 20", async () => {
      await sembrarPartidos(25);
      expect((await llamar()).body).toHaveLength(20);
    });

    it("se limita a 100 como máximo", async () => {
      await sembrarPartidos(105);
      expect((await llamar("?limit=500")).body).toHaveLength(100);
    });
  });

  describe("estado de sync", () => {
    const sync = (id: string, userId: string, matchId: string, status: string) =>
      t.db.insert(calendarSyncs).values({ id, userId, matchId, provider: "google", status });

    beforeEach(async () => {
      await seguir("river");
      await partido("sincronizado", { horas: 1 });
      await partido("sin-sync", { horas: 2 });
      await partido("de-otro", { horas: 3 });
    });

    it("incluye el estado del usuario y null cuando no hay", async () => {
      await sync("s1", fixtures.user.id, "sincronizado", "needs_update");
      expect((await llamar()).body.map((p: any) => [p.id, p.syncStatus])).toEqual([
        ["sincronizado", "needs_update"],
        ["sin-sync", null],
        ["de-otro", null],
      ]);
    });

    it("ignora el sync de otro usuario", async () => {
      await sync("s2", fixtures.other.id, "de-otro", "synced");
      expect((await llamar()).body.find((p: any) => p.id === "de-otro").syncStatus).toBeNull();
    });
  });

  it("expone solo los campos públicos del partido, los equipos y la liga", async () => {
    await seguir("river");
    await partido("m1");
    const [p] = (await llamar()).body;

    expect(Object.keys(p).sort()).toEqual(
      ["awayScore", "awayTeam", "dateTime", "homeScore", "homeTeam", "id", "league", "round", "status", "syncStatus", "venue"].sort()
    );
    expect(p.homeTeam).toMatchObject({ id: "river", name: "River Plate" });
    expect(p.awayTeam).toMatchObject({ id: "boca", name: "Boca Juniors" });
    expect(p.league).toEqual({ id: "test-league", name: "Liga de prueba", country: "Argentina" });
  });
});
