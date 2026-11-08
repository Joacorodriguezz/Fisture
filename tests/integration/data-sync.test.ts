import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import scoreboard from "../fixtures/espn-scoreboard.json";
import { useTestDb } from "../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../helpers/clock";
import { syncLote, syncSingleLeague } from "../../src/lib/data-providers/sync";
import { LEAGUES_CONFIG, lotesDeSync } from "../../src/lib/data-providers";
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

    // drizzle-orm >= 0.44 envuelve los errores de D1: el resultado (que va a sync_runs y a /admin)
    // muestra el error de D1, no el SQL con todos los valores de la fila.
    it("si D1 falla, el error informado es el de D1 y no el SQL con sus parámetros", async () => {
      await t.DB.prepare(
        "CREATE TRIGGER falla_ligas BEFORE INSERT ON leagues BEGIN SELECT RAISE(ABORT, 'falla simulada de D1'); END"
      ).run();
      try {
        const { errors } = await sync();
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain("falla simulada de D1");
        expect(errors[0]).not.toContain("Failed query");
      } finally {
        await t.DB.prepare("DROP TRIGGER falla_ligas").run();
      }
    });
  });

  describe("copas no destacadas (docs/22)", () => {
    // Un cruce de un equipo conocido contra un amateur y otro entre dos amateurs
    const conAmateurs = () => {
      const base = data.events[0];
      const cruce = (id: string, local: [string, string], visitante: [string, string]) => ({
        ...structuredClone(base),
        id,
        season: { year: AHORA.getUTCFullYear(), slug: "round-of-32" },
        competitions: [{ venue: { fullName: "Cancha" }, competitors: [
          { homeAway: "home", score: "0", team: { id: local[0], displayName: local[1], abbreviation: local[1].slice(0, 3) } },
          { homeAway: "away", score: "0", team: { id: visitante[0], displayName: visitante[1], abbreviation: visitante[1].slice(0, 3) } },
        ] }],
      });
      data.events = [cruce("c1", ["16", "River Plate"], ["900", "Club Amateur"]), cruce("c2", ["901", "Otro Amateur"], ["902", "Tercer Amateur"])];
    };

    it("solo guarda los partidos de equipos de competencias destacadas, con su rival", async () => {
      await sync();
      conAmateurs();

      expect(await sync("arg.copa")).toMatchObject({ teamsCreated: 1, matchesCreated: 1, errors: [] });
      const [copa] = await t.db.select().from(leagues).where(eq(leagues.externalId, "arg.copa"));
      expect(copa).toMatchObject({ isFeatured: false, isActive: true });
      expect(await t.db.select().from(matches).where(eq(matches.leagueId, copa.id))).toEqual([
        expect.objectContaining({ externalId: "espn:c1", round: "Dieciseisavos de final" }),
      ]);
      const participantes = await t.db.select().from(leagueTeams).where(eq(leagueTeams.leagueId, copa.id));
      expect(participantes).toHaveLength(2);
    });

    it("sin equipos conocidos no carga nada", async () => {
      conAmateurs();
      expect(await sync("arg.copa")).toMatchObject({ teamsCreated: 0, matchesCreated: 0, errors: [] });
      expect(await t.db.select().from(teams)).toHaveLength(0);
    });

    it("las ligas y copas internacionales destacadas se marcan como destacadas", async () => {
      await sync();
      await sync("conmebol.libertadores");
      expect((await t.db.select().from(leagues)).map((l) => l.isFeatured)).toEqual([true, true]);
    });
  });

  describe("liga de origen", () => {
    it("un equipo que entró por una copa adopta su liga cuando esa liga se sincroniza", async () => {
      await sync("conmebol.libertadores");
      expect((await t.db.select().from(teams)).map((e) => e.country)).toEqual([null, null]);

      expect(await sync("arg.1")).toMatchObject({ teamsCreated: 0, teamsUpdated: 2, errors: [] });
      const [liga] = await t.db.select().from(leagues).where(eq(leagues.externalId, "arg.1"));
      expect(await t.db.select().from(teams)).toEqual([
        expect.objectContaining({ leagueId: liga.id, country: "Argentina" }),
        expect.objectContaining({ leagueId: liga.id, country: "Argentina" }),
      ]);

      // Ya adoptada, una segunda pasada no vuelve a escribir
      expect(await sync("arg.1")).toMatchObject({ teamsUpdated: 0 });
    });
  });

  describe("sync por lotes (docs/22 D4)", () => {
    it("cada lote informa el siguiente y el último cierra con null", async () => {
      const total = lotesDeSync().length;
      const primero = await syncLote({ DB: t.DB }, 0);
      expect(primero).toMatchObject({ lote: 0, totalLotes: total, siguienteLote: 1 });
      expect(primero.results.map((r) => r.league)).toEqual(LEAGUES_CONFIG.slice(0, 5).map((l) => l.name));
    });

    it("el último lote desactiva las competencias que ya no están configuradas", async () => {
      await t.db.insert(leagues).values({ externalId: "vieja.1", name: "Liga vieja", country: "X", season: 2020, source: "espn" });
      const total = lotesDeSync().length;

      expect(await syncLote({ DB: t.DB }, total - 1)).toMatchObject({ siguienteLote: null });
      const [vieja] = await t.db.select().from(leagues).where(eq(leagues.externalId, "vieja.1"));
      expect(vieja.isActive).toBe(false);
    });

    // docs/30 D3: el DISTINCT de equipos conocidos lee ~2.700 filas; antes corría una vez por copa
    describe("equipos conocidos", () => {
      const conConsultas = () => {
        const sqls: string[] = [];
        const DB = new Proxy(t.DB, {
          get(target, prop) {
            if (prop === "prepare") return (q: string) => (sqls.push(q), target.prepare(q));
            const valor = Reflect.get(target, prop);
            return typeof valor === "function" ? valor.bind(target) : valor;
          },
        });
        return { DB, distintos: () => sqls.filter((q) => q.startsWith("select distinct")).length };
      };
      const loteDe = (externalId: string) => lotesDeSync().findIndex((l) => l.some((c) => c.externalId === externalId));

      // Cada competencia recibe un partido propio, así las copas no chocan con el de la liga
      beforeEach(() => {
        vi.stubGlobal("fetch", vi.fn(async (url: string) => {
          const copia = structuredClone(data);
          copia.events[0].id = `${copia.events[0].id}-${new URL(url).pathname.split("/").slice(-2, -1)[0]}`;
          return Response.json(copia);
        }));
      });

      it("un lote de copas los consulta una sola vez", async () => {
        await sync();
        const { DB, distintos } = conConsultas();
        const lote = loteDe("eng.fa");
        expect(lotesDeSync()[lote].filter((c) => !c.destacada).length).toBeGreaterThan(1);

        await syncLote({ DB }, lote);
        expect(distintos()).toBe(1);
      });

      it("una copa ve los equipos que cargó una competencia destacada del mismo lote", async () => {
        const lote = loteDe("conmebol.libertadores");
        const { DB, distintos } = conConsultas();

        await syncLote({ DB }, lote);
        expect(distintos()).toBe(1);
        const [qual] = await t.db.select().from(leagues).where(eq(leagues.externalId, "uefa.champions_qual"));
        expect(await t.db.select().from(matches).where(eq(matches.leagueId, qual.id))).toHaveLength(1);
      });
    });

    it.each([-1, 1.5, 999])("un lote inexistente (%s) es un error", async (lote) => {
      await expect(syncLote({ DB: t.DB }, lote)).rejects.toThrow(RangeError);
    });
  });
});
