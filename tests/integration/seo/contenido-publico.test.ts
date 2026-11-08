import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { leagues, teams, leagueTeams, matches } from "../../../drizzle/schema";
import { getLeagueUpcomingMatches, getEquiposParaExplorar } from "../../../src/lib/db/queries";

describe("contenido público de ligas y home", () => {
  const t = useTestDb();
  relojFijo();
  beforeEach(async () => { await seedApp(t.db); });

  it("el fixture respeta competencia, estado y límites de los 30 días", async () => {
    await t.db.insert(leagues).values({ id: "otra", externalId: "otra", name: "Otra", country: "AR", season: 2026 });
    const casos = [
      { id: "ahora", dias: 0 }, { id: "antes", dias: -1 },
      { id: "limite", dias: 30 }, { id: "ultima", dias: 29 },
      { id: "otra", dias: 1, leagueId: "otra" },
      ...["cancelled", "postponed", "finished", "live"].map(status => ({ id: status, dias: 1, status })),
    ];
    await t.db.insert(matches).values(casos.map(c => ({
      id: c.id, externalId: c.id, leagueId: "leagueId" in c ? c.leagueId : "test-league",
      homeTeamId: "river", awayTeamId: "boca", status: "status" in c ? c.status : "scheduled",
      dateTime: new Date(AHORA.getTime() + c.dias * DIA_MS),
    })));
    const filas = await getLeagueUpcomingMatches(t.db, "test-league");
    expect(filas.map(f => f.match.id)).toEqual(["ahora", "superclasico", "ultima"]);
    expect(filas[0]).toMatchObject({ homeTeam: { id: "river" }, awayTeam: { id: "boca" } });
    await t.db.update(leagues).set({ isActive: false }).where(eq(leagues.id, "test-league"));
    expect(await getLeagueUpcomingMatches(t.db, "test-league")).toEqual([]);
    expect(await getLeagueUpcomingMatches(t.db, "inexistente")).toEqual([]);
  });

  it("limita a 20 encuentros con desempate estable por id", async () => {
    const filas = Array.from({ length: 25 }, (_, i) => ({
      id: `partido-${String(i).padStart(2, "0")}`, externalId: `partido-${i}`,
      leagueId: "test-league", homeTeamId: "river", awayTeamId: "boca", dateTime: AHORA,
    }));
    for (let i = 0; i < filas.length; i += 10) await t.db.insert(matches).values(filas.slice(i, i + 10));
    expect((await getLeagueUpcomingMatches(t.db, "test-league")).map(f => f.match.id))
      .toEqual(Array.from({ length: 20 }, (_, i) => `partido-${String(i).padStart(2, "0")}`));
  });

  it("home no duplica equipos de varias ligas y excluye competencias inactivas o no destacadas", async () => {
    await t.db.insert(leagues).values([
      { id: "copa", externalId: "copa", name: "Copa", country: "AR", season: 2026 },
      { id: "oculta", externalId: "oculta", name: "Oculta", country: "AR", season: 2026, isFeatured: false },
      { id: "inactiva", externalId: "inactiva", name: "Inactiva", country: "AR", season: 2026, isActive: false },
    ]);
    await t.db.insert(teams).values(["oculta", "inactiva"].map(id => ({ id, externalId: id, name: id, leagueId: id })));
    await t.db.insert(leagueTeams).values([
      { leagueId: "copa", teamId: "river" },
      { leagueId: "oculta", teamId: "oculta" }, { leagueId: "inactiva", teamId: "inactiva" },
    ]);
    expect((await getEquiposParaExplorar(t.db)).map(e => e.id)).toEqual(["boca", "river"]);
  });

  it("home entrega como máximo seis enlaces en orden alfabético", async () => {
    await t.db.insert(teams).values(Array.from({ length: 10 }, (_, i) => ({
      id: `extra-${i}`, externalId: `extra-${i}`, name: `A equipo ${i}`, leagueId: "test-league",
    })));
    await t.db.insert(leagueTeams).values(Array.from({ length: 10 }, (_, i) => ({ leagueId: "test-league", teamId: `extra-${i}` })));
    expect((await getEquiposParaExplorar(t.db)).map(e => e.id)).toEqual(Array.from({ length: 6 }, (_, i) => `extra-${i}`));
  });
});
