// Página pública de liga (docs/34): últimos resultados de la liga (L3)
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { leagues, matches } from "../../../drizzle/schema";
import { getLeagueRecentMatches } from "../../../src/lib/db/queries";

describe("página de liga", () => {
  const t = useTestDb();
  relojFijo();
  beforeEach(async () => {
    await seedApp(t.db);
    await t.db.insert(leagues).values({ id: "otra-liga", externalId: "test:otra", name: "Otra liga", country: "Chile", season: 2026 });
  });

  const jugado = (id: string, dias: number, extra: Partial<typeof matches.$inferInsert> = {}) => ({
    id, externalId: id, leagueId: "test-league", homeTeamId: "river", awayTeamId: "boca",
    dateTime: new Date(AHORA.getTime() + dias * DIA_MS), status: "finished", homeScore: 1, awayScore: 0, ...extra,
  });

  describe("getLeagueRecentMatches", () => {
    it("trae solo terminados ya jugados de esa liga, del más reciente al más antiguo, con equipos y liga", async () => {
      await t.db.insert(matches).values([
        jugado("hace-3", -3),
        jugado("hace-1", -1, { homeTeamId: "boca", awayTeamId: "river", homeScore: null, awayScore: null }),
        jugado("hace-2", -2),
        jugado("de-otra-liga", -1, { leagueId: "otra-liga" }),
        jugado("postergado", -4, { status: "postponed" }),
        jugado("cancelado", -5, { status: "cancelled" }),
        jugado("en-vivo", 0, { status: "live", dateTime: new Date(AHORA.getTime() - 60_000) }),
        jugado("programado-pasado", -6, { status: "scheduled" }),
        // Dato raro de la fuente: "terminado" con fecha futura. No es un resultado todavía
        jugado("futuro", 2),
      ]);
      const filas = await getLeagueRecentMatches(t.db, "test-league");
      expect(filas.map((f) => f.match.id)).toEqual(["hace-1", "hace-2", "hace-3"]);
      expect(filas[0]).toMatchObject({ homeTeam: { id: "boca" }, awayTeam: { id: "river" }, league: { id: "test-league" } });
      // El marcador nulo llega nulo: la página no lo muestra
      expect(filas[0].match).toMatchObject({ homeScore: null, awayScore: null });
      expect(filas[1].match).toMatchObject({ homeScore: 1, awayScore: 0 });
      expect((await getLeagueRecentMatches(t.db, "otra-liga")).map((f) => f.match.id)).toEqual(["de-otra-liga"]);
    });

    it("corta en 10 por defecto y respeta el límite y el instante pedidos", async () => {
      const doce = Array.from({ length: 12 }, (_, i) => jugado(`j${String(i).padStart(2, "0")}`, -(i + 1)));
      // D1 admite 100 parámetros por sentencia: de a 6 filas
      await t.db.insert(matches).values(doce.slice(0, 6));
      await t.db.insert(matches).values(doce.slice(6));
      const filas = await getLeagueRecentMatches(t.db, "test-league");
      expect(filas).toHaveLength(10);
      expect(filas[0].match.id).toBe("j00");
      expect(await getLeagueRecentMatches(t.db, "test-league", 2)).toHaveLength(2);
      const antes = new Date(AHORA.getTime() - 10.5 * DIA_MS);
      expect((await getLeagueRecentMatches(t.db, "test-league", 10, antes)).map((f) => f.match.id)).toEqual(["j10", "j11"]);
      expect(await getLeagueRecentMatches(t.db, "inexistente")).toEqual([]);
    });

    it("una liga inactiva no publica resultados, igual que sus próximos partidos", async () => {
      await t.db.insert(matches).values(jugado("hace-1", -1));
      await t.db.update(leagues).set({ isActive: false }).where(eq(leagues.id, "test-league"));
      expect(await getLeagueRecentMatches(t.db, "test-league")).toEqual([]);
    });
  });
});
