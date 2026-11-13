// Página pública de equipo (docs/31): últimos resultados (D3) y equipos sin partidos fuera del sitemap (D8)
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { leagueTeams, matches, teams } from "../../../drizzle/schema";
import { getPaginasPublicas, getTeamRecentMatches } from "../../../src/lib/db/queries";

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
