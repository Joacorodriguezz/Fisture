import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import scoreboard from "../fixtures/espn-scoreboard.json";
import { useTestDb } from "../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../helpers/clock";
import { syncSingleLeague } from "../../src/lib/data-providers/sync";
import { leagues, teams, matches, leagueTeams } from "../../drizzle/schema";

describe("ingesta ESPN a D1", () => {
  const t = useTestDb();
  let data: typeof scoreboard;
  relojFijo();
  beforeEach(() => {
    data = structuredClone(scoreboard);
    data.events[0].date = new Date(AHORA.getTime() + DIA_MS).toISOString();
    data.events[0].season.year = AHORA.getUTCFullYear();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(data)));
  });

  const sync = (leagueId = "arg.1") => syncSingleLeague({ DB: t.DB }, leagueId);

  describe("primera ingesta", () => {
    it("crea equipos y partido y vincula los equipos a la liga", async () => {
      expect(await sync()).toMatchObject({ teamsCreated: 2, matchesCreated: 1, errors: [] });
      expect(await t.db.select().from(leagueTeams)).toHaveLength(2);
    });
  });

  describe("ingesta repetida", () => {
    beforeEach(async () => {
      await sync();
    });

    it("sin cambios en el proveedor no escribe nada", async () => {
      expect(await sync()).toMatchObject({ teamsCreated: 0, teamsUpdated: 0, matchesCreated: 0, matchesUpdated: 0, errors: [] });
    });

    it("un cambio de hora y de nombre actualiza el existente sin duplicar", async () => {
      const [original] = await t.db.select().from(matches);
      data.events[0].date = new Date(AHORA.getTime() + 2 * DIA_MS).toISOString();
      data.events[0].competitions[0].competitors[1].team.displayName = "River Plate actualizado";

      expect(await sync()).toMatchObject({ teamsUpdated: 1, matchesUpdated: 1, errors: [] });

      // D1 guarda segundos: se compara con esa precisión
      const persistido = new Date(Math.floor(Date.parse(data.events[0].date) / 1000) * 1000);
      expect(await t.db.select().from(matches)).toEqual([expect.objectContaining({ id: original.id, dateTime: persistido })]);
      expect(await t.db.select().from(teams)).toHaveLength(2);
    });
  });

  describe("liga y copa", () => {
    it("comparten equipos conservando su liga de origen", async () => {
      await sync();
      const [liga] = await t.db.select().from(leagues).where(eq(leagues.externalId, "arg.1"));
      data.events[0].id = "cup-match";
      data.events[0].season.slug = "semifinals";

      expect(await sync("conmebol.libertadores")).toMatchObject({ teamsCreated: 0, matchesCreated: 1, errors: [] });
      expect(await t.db.select().from(teams)).toEqual([expect.objectContaining({ leagueId: liga.id }), expect.objectContaining({ leagueId: liga.id })]);
      expect(await t.db.select().from(leagueTeams)).toHaveLength(4);
    });
  });

  describe("fallos del proveedor", () => {
    it("un proveedor que falla no borra los datos existentes", async () => {
      await sync();
      vi.stubGlobal("fetch", vi.fn(async () => Response.json({}, { status: 400 })));

      expect(await sync()).toMatchObject({ matchesCreated: 0, matchesUpdated: 0 });
      expect(await t.db.select().from(matches)).toHaveLength(1);
    });

    it("una liga desconocida informa el error", async () => {
      expect((await sync("unknown")).errors).not.toHaveLength(0);
    });
  });
});
