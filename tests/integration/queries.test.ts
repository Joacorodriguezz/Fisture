import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../helpers/clock";
import { seedApp } from "../helpers/fixtures";
import { matches, leagues, userTeams, calendarSyncs } from "../../drizzle/schema";
import { getUpcomingMatches, getMatchesForTeams, getMatchesInRange, getMatchCountsByDay, getFollowedIds, getSyncStates } from "../../src/lib/db/queries";

describe("consultas de partidos", () => {
  const t = useTestDb();
  relojFijo();
  beforeEach(async () => {
    await seedApp(t.db);
  });

  const idsFaltantes = (n: number) => Array.from({ length: n }, (_, i) => `missing-${i}`);

  describe("próximos partidos del usuario", () => {
    beforeEach(async () => {
      await t.db.insert(userTeams).values([{ userId: "user-1", teamId: "river" }, { userId: "user-1", teamId: "boca" }]);
    });

    it("devuelve el partido futuro de los equipos seguidos, una sola vez aunque ambos equipos se sigan", async () => {
      expect(await getUpcomingMatches(t.db, "user-1")).toEqual([expect.objectContaining({ match: expect.objectContaining({ id: "superclasico" }) })]);
    });

    it("excluye los partidos pasados", async () => {
      await t.db.insert(matches).values({ id: "past", externalId: "past", leagueId: "test-league", homeTeamId: "river", awayTeamId: "boca", dateTime: new Date(AHORA.getTime() - DIA_MS) });
      expect((await getUpcomingMatches(t.db, "user-1")).map((m) => m.match.id)).toEqual(["superclasico"]);
    });

    it("un usuario que no sigue a nadie no recibe partidos", async () => {
      expect(await getUpcomingMatches(t.db, "user-2")).toEqual([]);
    });

    it("filtrar por un equipo que no se sigue devuelve una lista vacía", async () => {
      expect(await getUpcomingMatches(t.db, "user-1", 20, "unknown")).toEqual([]);
    });

    it("getFollowedIds devuelve solo los equipos del usuario", async () => {
      expect(await getFollowedIds(t.db, "user-1")).toEqual(new Set(["river", "boca"]));
    });
  });

  describe("getMatchesForTeams", () => {
    it("divide más de 100 equipos en lotes y elimina el partido duplicado", async () => {
      const ids = ["river", "boca", ...idsFaltantes(100), "river"];
      expect(await getMatchesForTeams(t.db, ids, 10)).toHaveLength(1);
    });
  });

  describe("rangos de fechas", () => {
    it("el límite superior es exclusivo", async () => {
      const [match] = await t.db.select().from(matches);
      expect(await getMatchesInRange(t.db, new Date(match.dateTime.getTime() - 1000), match.dateTime)).toEqual([]);
    });

    it("el límite inferior es inclusivo", async () => {
      const [match] = await t.db.select().from(matches);
      expect(await getMatchesInRange(t.db, match.dateTime, new Date(match.dateTime.getTime() + 1000))).toHaveLength(1);
    });
  });

  describe("getSyncStates", () => {
    beforeEach(async () => {
      await t.db.insert(calendarSyncs).values({ userId: "user-1", matchId: "superclasico", provider: "google", status: "synced" });
    });

    it("divide más de 100 ids en lotes y devuelve solo los existentes", async () => {
      expect(await getSyncStates(t.db, "user-1", ["superclasico", ...idsFaltantes(100)])).toEqual(new Map([["superclasico", { status: "synced", errorMessage: null }]]));
    });

    it("no filtra datos de otro usuario", async () => {
      expect(await getSyncStates(t.db, "user-2", ["superclasico", ...idsFaltantes(100)])).toEqual(new Map());
    });
  });

  describe("getMatchCountsByDay (día argentino, UTC-3)", () => {
    const desde = new Date("2026-10-21T03:00:00Z");
    const hasta = new Date("2026-10-22T03:00:00Z");

    beforeEach(async () => {
      await t.db.delete(matches);
      const fechas = ["2026-10-21T02:59:59Z", "2026-10-21T03:00:00Z", "2026-10-22T02:59:59Z", "2026-10-22T03:00:00Z"];
      await t.db.insert(matches).values(
        fechas.map((dateTime, i) => ({ id: `boundary-${i}`, externalId: `boundary-${i}`, leagueId: "test-league", homeTeamId: "river", awayTeamId: "boca", dateTime: new Date(dateTime) }))
      );
    });

    it("cuenta con los límites exactos del rango semiabierto", async () => {
      expect(await getMatchCountsByDay(t.db, desde, hasta)).toEqual(new Map([["2026-10-21", 2]]));
    });

    it("un partido a las 02:59:59Z cuenta para el día argentino anterior", async () => {
      expect(await getMatchCountsByDay(t.db, new Date("2026-10-20T03:00:00Z"), hasta)).toEqual(new Map([["2026-10-20", 1], ["2026-10-21", 2]]));
    });

    it("excluye las ligas inactivas", async () => {
      await t.db.update(leagues).set({ isActive: false }).where(eq(leagues.id, "test-league"));
      expect(await getMatchCountsByDay(t.db, desde, hasta)).toEqual(new Map());
    });
  });
});
