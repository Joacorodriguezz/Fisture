// Página pública de equipo (docs/33): últimos resultados (D3), equipos sin partidos fuera del sitemap (D8)
// y otros equipos de la misma liga (D10)
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { leagues, leagueTeams, matches, teams } from "../../../drizzle/schema";
import { getEquiposDeLaLiga, getPaginasPublicas, getTeamRecentMatches } from "../../../src/lib/db/queries";

describe("página de equipo", () => {
  const t = useTestDb();
  relojFijo();
  beforeEach(async () => { await seedApp(t.db); });

  const jugado = (id: string, dias: number, extra: Partial<typeof matches.$inferInsert> = {}) => ({
    id, externalId: id, leagueId: "test-league", homeTeamId: "river", awayTeamId: "boca",
    dateTime: new Date(AHORA.getTime() + dias * DIA_MS), status: "finished", homeScore: 1, awayScore: 0, ...extra,
  });

  describe("getTeamRecentMatches", () => {
    it("trae solo terminados ya jugados, del más reciente al más antiguo, con equipos y liga", async () => {
      await t.db.insert(matches).values([
        jugado("hace-3", -3),
        jugado("hace-1", -1, { homeTeamId: "boca", awayTeamId: "river", homeScore: null, awayScore: null }),
        jugado("hace-2", -2),
        jugado("postergado", -4, { status: "postponed" }),
        jugado("cancelado", -5, { status: "cancelled" }),
        jugado("en-vivo", 0, { status: "live", dateTime: new Date(AHORA.getTime() - 60_000) }),
        jugado("programado-pasado", -6, { status: "scheduled" }),
        // Dato raro de la fuente: "terminado" con fecha futura. No es un resultado todavía
        jugado("futuro", 2),
      ]);
      const filas = await getTeamRecentMatches(t.db, "river");
      expect(filas.map((f) => f.match.id)).toEqual(["hace-1", "hace-2", "hace-3"]);
      expect(filas[0]).toMatchObject({ homeTeam: { id: "boca" }, awayTeam: { id: "river" }, league: { id: "test-league" } });
      // El marcador nulo llega nulo: la página no lo muestra
      expect(filas[0].match).toMatchObject({ homeScore: null, awayScore: null });
      expect(filas[1].match).toMatchObject({ homeScore: 1, awayScore: 0 });
    });

    it("corta en 5 por defecto y respeta el límite y el instante pedidos", async () => {
      await t.db.insert(matches).values(Array.from({ length: 8 }, (_, i) => jugado(`j${i}`, -(i + 1))));
      expect((await getTeamRecentMatches(t.db, "boca")).map((f) => f.match.id)).toEqual(["j0", "j1", "j2", "j3", "j4"]);
      expect(await getTeamRecentMatches(t.db, "boca", 2)).toHaveLength(2);
      const antes = new Date(AHORA.getTime() - 6.5 * DIA_MS);
      expect((await getTeamRecentMatches(t.db, "boca", 5, antes)).map((f) => f.match.id)).toEqual(["j6", "j7"]);
      expect(await getTeamRecentMatches(t.db, "inexistente")).toEqual([]);
    });
  });

  describe("getEquiposDeLaLiga (D10)", () => {
    beforeEach(async () => {
      await t.db.insert(leagues).values({ id: "otra-liga", externalId: "test:otra", name: "Otra liga", country: "Chile", season: 2026 });
      await t.db.insert(teams).values([
        { id: "zz-atletico", externalId: "test:atl-1", name: "Atlético", leagueId: "test-league", slug: "atletico" },
        { id: "aa-atletico", externalId: "test:atl-2", name: "Atlético", leagueId: "test-league" },
        { id: "colo-colo", externalId: "test:colo", name: "Colo-Colo", leagueId: "otra-liga", slug: "colo-colo" },
      ]);
      await t.db.insert(leagueTeams).values([
        { leagueId: "test-league", teamId: "zz-atletico" },
        { leagueId: "test-league", teamId: "aa-atletico" },
        { leagueId: "otra-liga", teamId: "colo-colo" },
        // River también juega otra competencia: no suma a Colo-Colo a la lista de su liga
        { leagueId: "otra-liga", teamId: "river" },
      ]);
    });

    it("trae los otros equipos de la liga por nombre y luego id, sin el propio y con el slug", async () => {
      const equipos = await getEquiposDeLaLiga(t.db, "test-league", "river");
      expect(equipos).toEqual([
        { id: "aa-atletico", slug: null, name: "Atlético", shortName: null, logo: null },
        { id: "zz-atletico", slug: "atletico", name: "Atlético", shortName: null, logo: null },
        { id: "boca", slug: null, name: "Boca Juniors", shortName: "BOC", logo: null },
      ]);
    });

    it("una liga sin otros equipos devuelve una lista vacía", async () => {
      expect(await getEquiposDeLaLiga(t.db, "otra-liga", "colo-colo")).toEqual([{ id: "river", slug: null, name: "River Plate", shortName: "RIV", logo: null }]);
      await t.db.delete(leagueTeams).where(eq(leagueTeams.teamId, "river"));
      expect(await getEquiposDeLaLiga(t.db, "otra-liga", "colo-colo")).toEqual([]);
      expect(await getEquiposDeLaLiga(t.db, "inexistente", "river")).toEqual([]);
    });

    it("corta en 40 equipos", async () => {
      const ids = Array.from({ length: 45 }, (_, i) => `equipo-${String(i).padStart(2, "0")}`);
      // De a 15 filas: D1 admite hasta 100 parámetros por sentencia
      for (let i = 0; i < ids.length; i += 15) {
        const tanda = ids.slice(i, i + 15);
        await t.db.insert(teams).values(tanda.map((id) => ({ id, externalId: `test:${id}`, name: `Equipo ${id.slice(-2)}`, leagueId: "otra-liga" })));
        await t.db.insert(leagueTeams).values(tanda.map((teamId) => ({ leagueId: "otra-liga", teamId })));
      }
      const equipos = await getEquiposDeLaLiga(t.db, "otra-liga", "colo-colo");
      expect(equipos).toHaveLength(40);
      expect(equipos[0].id).toBe("equipo-00");
      expect(equipos.map((e) => e.id)).not.toContain("colo-colo");
    });
  });

  describe("sitemap: equipos con partidos (D8)", () => {
    beforeEach(async () => {
      await t.db.insert(teams).values([
        { id: "sin-partidos", externalId: "test:sin", name: "Sin Partidos", leagueId: "test-league" },
        { id: "con-resultado", externalId: "test:resultado", name: "Con Resultado", leagueId: "test-league" },
        { id: "solo-cancelado-pasado", externalId: "test:cancelado", name: "Cancelado", leagueId: "test-league" },
      ]);
      await t.db.insert(leagueTeams).values(["sin-partidos", "con-resultado", "solo-cancelado-pasado"].map((teamId) => ({ leagueId: "test-league", teamId })));
      await t.db.insert(matches).values([
        jugado("viejo", -200, { homeTeamId: "con-resultado", awayTeamId: "boca" }),
        jugado("cancelado-pasado", -3, { homeTeamId: "solo-cancelado-pasado", awayTeamId: "boca", status: "cancelled" }),
      ]);
    });

    it("lista al equipo con un partido próximo o un resultado, y deja afuera al que no tiene ninguno", async () => {
      const { equipos } = await getPaginasPublicas(t.db, AHORA);
      expect(equipos.map((e) => e.id)).toEqual(["boca", "con-resultado", "river"]);
    });

    it("el equipo vuelve al sitemap cuando tiene un partido programado", async () => {
      await t.db.insert(matches).values(jugado("nuevo", 3, { homeTeamId: "sin-partidos", status: "scheduled", homeScore: null, awayScore: null }));
      expect((await getPaginasPublicas(t.db, AHORA)).equipos.map((e) => e.id)).toContain("sin-partidos");
    });

    it("un equipo cuyo único partido ya pasó sin terminar queda afuera", async () => {
      await t.db.update(matches).set({ dateTime: new Date(AHORA.getTime() - DIA_MS) }).where(eq(matches.id, "superclasico"));
      const ids = (await getPaginasPublicas(t.db, AHORA)).equipos.map((e) => e.id);
      expect(ids).not.toContain("river");
      // Boca conserva sus resultados contra los otros dos equipos
      expect(ids).toContain("boca");
    });
  });
});
