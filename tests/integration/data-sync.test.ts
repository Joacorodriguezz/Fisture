import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import scoreboard from "../fixtures/espn-scoreboard.json";
import prodeFin90 from "../fixtures/espn-prode-fin-90.json";
import prodeAlargue from "../fixtures/espn-prode-alargue.json";
import prodePenales from "../fixtures/espn-prode-penales.json";
import prodeSumAlargue from "../fixtures/espn-prode-summary-alargue.json";
import prodeSumPenales from "../fixtures/espn-prode-summary-penales.json";
import { useTestDb } from "../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../helpers/clock";
import { d1ConCambioAntesDelBatch } from "../helpers/d1-intercalado";
import { kvEnMemoria, silenciarConsola } from "../helpers/ctx";
import { MAX_REEMPLAZOS_PRODE, MAX_RESUMENES_PRODE, syncLote, syncSingleLeague } from "../../src/lib/data-providers/sync";
import { LEAGUES_CONFIG, lotesDeSync } from "../../src/lib/data-providers";
import { markOutdatedEvents } from "../../src/lib/calendar/sync-service";
import { guardarPronostico, listarPronosticos } from "../../src/lib/prode/pronosticos";
import { calendarSyncs, leagues, teams, matches, leagueTeams, prodeMatches, prodePredictions, users } from "../../drizzle/schema";

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

  describe("logo de la competencia (docs/36)", () => {
    const logoDe = (href: string) => ({ logos: [{ href, rel: ["full", "default"] }] });
    const logoGuardado = async (id: string) => (await t.db.select().from(leagues).where(eq(leagues.externalId, id)))[0].logo;

    // La Copa Argentina no tiene logo propio: se usa el de ESPN
    it("sin logo propio: lo escribe, lo actualiza si cambia y no lo pisa con null", async () => {
      Object.assign(data, { leagues: [logoDe("https://x/1.png")] });
      await sync("arg.copa");
      expect(await logoGuardado("arg.copa")).toBe("https://x/1.png");

      Object.assign(data, { leagues: [logoDe("https://x/2.png")] });
      await sync("arg.copa");
      expect(await logoGuardado("arg.copa")).toBe("https://x/2.png");

      Object.assign(data, { leagues: [{}] });
      await sync("arg.copa");
      expect(await logoGuardado("arg.copa")).toBe("https://x/2.png");
    });

    it("con logo propio: gana sobre el de ESPN", async () => {
      Object.assign(data, { leagues: [logoDe("https://x/1.png")] });
      await sync("arg.1");
      expect(await logoGuardado("arg.1")).toBe("/logos/competencias/arg.1.png");
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

  // docs/32 Fase A: mismo mecanismo con las ligas sudamericanas nuevas
  describe("liga de origen en las ligas sudamericanas nuevas (docs/32)", () => {
    it("un club que entró por la Libertadores sin país adopta uru.1", async () => {
      const [local, visitante] = data.events[0].competitions[0].competitors;
      local.team = { id: "2000", displayName: "Peñarol", abbreviation: "PEN" };
      visitante.team = { id: "2001", displayName: "Nacional", abbreviation: "NAC" };
      await sync("conmebol.libertadores");
      expect((await t.db.select().from(teams)).map((e) => e.country)).toEqual([null, null]);

      expect(await sync("uru.1")).toMatchObject({ teamsCreated: 0, teamsUpdated: 2, errors: [] });
      const [liga] = await t.db.select().from(leagues).where(eq(leagues.externalId, "uru.1"));
      expect(liga).toMatchObject({ isFeatured: true, name: "Liga AUF Uruguaya" });
      expect(await t.db.select().from(teams)).toEqual([
        expect.objectContaining({ leagueId: liga.id, country: "Uruguay" }),
        expect.objectContaining({ leagueId: liga.id, country: "Uruguay" }),
      ]);
      expect(await sync("uru.1")).toMatchObject({ teamsUpdated: 0, matchesUpdated: 0 });
    });
  });

  // docs/32 Fase B: las selecciones entran por las Eliminatorias (plantel fijo, sin partidos) y los
  // amistosos solo guardan los partidos de una selección sudamericana
  describe("selecciones de CONMEBOL (docs/32 Fase B)", () => {
    const PLANTEL: [string, string][] = [
      ["202", "Argentina"], ["204", "Bolívia"], ["205", "Brasil"], ["207", "Chile"], ["208", "Colombia"],
      ["209", "Ecuador"], ["210", "Paraguay"], ["211", "Perú"], ["212", "Uruguay"], ["213", "Venezuela"],
    ];
    const amistoso = (id: string, local: [string, string], visitante: [string, string]) => ({
      ...structuredClone(scoreboard.events[0]),
      id,
      date: new Date(AHORA.getTime() + DIA_MS).toISOString(),
      season: { year: AHORA.getUTCFullYear(), slug: "regular-season" },
      competitions: [{ venue: { fullName: "Estadio" }, competitors: [
        { homeAway: "home", score: "0", team: { id: local[0], displayName: local[1], abbreviation: local[1].slice(0, 3), logo: `https://logo/${local[0]}.png` } },
        { homeAway: "away", score: "0", team: { id: visitante[0], displayName: visitante[1], abbreviation: visitante[1].slice(0, 3), logo: `https://logo/${visitante[0]}.png` } },
      ] }],
    });

    beforeEach(() => {
      const eventos = [
        amistoso("f1", ["202", "Argentina"], ["300", "Costa Rica"]),
        amistoso("f2", ["400", "Japón"], ["401", "Corea del Sur"]),
      ];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (url.includes("/teams")) {
          return Response.json({ sports: [{ leagues: [{ teams: PLANTEL.map(([id, displayName]) => ({ team: { id, displayName, abbreviation: displayName.slice(0, 3), logos: [{ href: `https://logo/${id}.png` }] } })) }] }] });
        }
        return Response.json({ events: url.includes("/fifa.friendly/") ? eventos : [] });
      }));
    });

    const eliminatorias = () => sync("fifa.worldq.conmebol");

    it("las Eliminatorias sin partidos cargan las 10 selecciones con su país y nombre en español", async () => {
      expect(await eliminatorias()).toMatchObject({ teamsCreated: 10, matchesCreated: 0, errors: [] });
      const [liga] = await t.db.select().from(leagues).where(eq(leagues.externalId, "fifa.worldq.conmebol"));
      expect(liga).toMatchObject({ isFeatured: true, name: "Eliminatorias Sudamericanas" });
      const filas = await t.db.select().from(teams);
      expect(filas).toHaveLength(10);
      expect(filas.every((e) => e.leagueId === liga.id && e.country === "Sudamérica")).toBe(true);
      expect(filas.find((e) => e.externalId === "espn:204")?.name).toBe("Bolivia");
      expect(await t.db.select().from(leagueTeams)).toHaveLength(10);
    });

    it("un amistoso de una selección sudamericana se guarda con su rival; Japón-Corea no", async () => {
      await eliminatorias();
      expect(await sync("fifa.friendly")).toMatchObject({ teamsCreated: 1, matchesCreated: 1, errors: [] });
      const [amistosos] = await t.db.select().from(leagues).where(eq(leagues.externalId, "fifa.friendly"));
      expect(amistosos).toMatchObject({ isFeatured: false });
      expect(await t.db.select().from(matches)).toEqual([expect.objectContaining({ externalId: "espn:f1", leagueId: amistosos.id })]);
      const nombres = (await t.db.select().from(teams)).map((e) => e.name);
      expect(nombres).toContain("Costa Rica");
      expect(nombres).not.toContain("Japón");
    });

    it("el rival de un amistoso no participa de ninguna competencia destacada (no se busca)", async () => {
      await eliminatorias();
      await sync("fifa.friendly");
      const [costaRica] = await t.db.select().from(teams).where(eq(teams.externalId, "espn:300"));
      expect(costaRica).toMatchObject({ country: null, leagueId: expect.any(String) });
      const destacadas = await t.db
        .select({ id: leagueTeams.teamId })
        .from(leagueTeams)
        .innerJoin(leagues, eq(leagueTeams.leagueId, leagues.id))
        .where(eq(leagues.isFeatured, true));
      expect(destacadas.map((d) => d.id)).not.toContain(costaRica.id);
    });

    it("un segundo sync no escribe nada, ni siquiera nombres", async () => {
      await eliminatorias();
      await sync("fifa.friendly");
      expect(await eliminatorias()).toMatchObject({ teamsCreated: 0, teamsUpdated: 0, matchesCreated: 0, matchesUpdated: 0, errors: [] });
      expect(await sync("fifa.friendly")).toMatchObject({ teamsCreated: 0, teamsUpdated: 0, matchesCreated: 0, matchesUpdated: 0, errors: [] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("si /teams falla, falla solo esa competencia y no deja datos a medias", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      vi.stubGlobal("fetch", vi.fn(async (url: string) =>
        url.includes("/teams") ? new Response("{}", { status: 500 }) : Response.json({ events: [] })
      ));
      const resultado = sync("fifa.worldq.conmebol");
      await vi.runAllTimersAsync();
      expect((await resultado).errors).toEqual([expect.stringContaining("HTTP 500")]);
      expect(await t.db.select().from(teams)).toHaveLength(0);
    });

    it("si /teams responde 200 sin equipos, falla esa competencia y no escribe nada", async () => {
      vi.stubGlobal("fetch", vi.fn(async (url: string) =>
        url.includes("/teams") ? Response.json({ sports: [{ leagues: [{ teams: [] }] }] }) : Response.json({ events: [] })
      ));
      expect((await sync("fifa.worldq.conmebol")).errors).toEqual([expect.stringContaining("plantel vacío")]);
      expect(await t.db.select().from(teams)).toHaveLength(0);
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
        // Con la configuración real una destacada y una copa ya no caen en el mismo lote (las ligas
        // sudamericanas corrieron los cortes): se reordena la configuración, que es un array mutable
        const original = [...LEAGUES_CONFIG];
        try {
          const libertadores = LEAGUES_CONFIG.splice(LEAGUES_CONFIG.findIndex((c) => c.externalId === "conmebol.libertadores"), 1)[0];
          LEAGUES_CONFIG.splice(LEAGUES_CONFIG.findIndex((c) => c.externalId === "uefa.champions_qual"), 0, libertadores);
          // Tope de vueltas: si no hay otra destacada para mover, el test falla en vez de colgarse
          for (let vueltas = 0; loteDe("conmebol.libertadores") !== loteDe("uefa.champions_qual"); vueltas++) {
            // Corre los cortes sacando una destacada que no es la Libertadores
            const i = LEAGUES_CONFIG.findIndex((c) => c.tipo === "copa" && c.destacada && c.externalId !== "conmebol.libertadores");
            expect(i).toBeGreaterThanOrEqual(0);
            expect(vueltas).toBeLessThan(LEAGUES_CONFIG.length);
            LEAGUES_CONFIG.push(...LEAGUES_CONFIG.splice(i, 1));
          }
          const lote = loteDe("conmebol.libertadores");
          const { DB, distintos } = conConsultas();

          await syncLote({ DB }, lote);
          expect(distintos()).toBe(1);
          const [qual] = await t.db.select().from(leagues).where(eq(leagues.externalId, "uefa.champions_qual"));
          expect(await t.db.select().from(matches).where(eq(matches.leagueId, qual.id))).toHaveLength(1);
        } finally {
          LEAGUES_CONFIG.splice(0, LEAGUES_CONFIG.length, ...original);
        }
      });
    });

    it.each([-1, 1.5, 999])("un lote inexistente (%s) es un error", async (lote) => {
      await expect(syncLote({ DB: t.DB }, lote)).rejects.toThrow(RangeError);
    });
  });

  // docs/37 §5: un partido del prode que empezó y se suspende no reabre los pronósticos aunque ESPN
  // publique la fecha de reanudación (postponed con fecha futura)
  describe("cierre irreversible de un partido del prode", () => {
    it("empezado y después postergado a una fecha futura: sigue cerrado y rechaza pronósticos", async () => {
      data.events[0].date = new Date(AHORA.getTime() - 3_600_000).toISOString();
      await sync();
      const [m] = await t.db.select().from(matches);
      await t.db.insert(prodeMatches).values({ matchId: m.id, fase: "cuartos", createdAt: AHORA });
      await t.db.insert(users).values({ id: "u1", provider: "google", providerId: "p1", email: "u1@example.test", name: "U1" });

      data.events[0].date = new Date(AHORA.getTime() + 2 * DIA_MS).toISOString();
      data.events[0].status.type.name = "STATUS_POSTPONED";
      data.events[0].status.type.state = "post";
      await sync();
      expect(await t.db.select().from(matches)).toEqual([expect.objectContaining({ status: "postponed" })]);
      expect((await t.db.select().from(prodeMatches))[0].closedAt).toBe(AHORA.getTime());
      expect(await guardarPronostico(t.db, "u1", { matchId: m.id, homeGoals: 1, awayGoals: 0 })).toMatchObject({ ok: false, status: 409, error: "pronostico_cerrado" });
      const [listado] = await listarPronosticos(t.db, "u1", AHORA);
      expect(listado.estado).toBe("cerrado");
    });

    it("un partido del prode que no empezó no se cierra", async () => {
      await sync();
      const [m] = await t.db.select().from(matches);
      await t.db.insert(prodeMatches).values({ matchId: m.id, fase: "cuartos", createdAt: AHORA });
      data.events[0].date = new Date(AHORA.getTime() + 2 * DIA_MS).toISOString();
      await sync();
      expect((await t.db.select().from(prodeMatches))[0].closedAt).toBeNull();
    });
  });

  // docs/37: un cruce del prode cargado a mano antes de que ESPN publique el partido. Cuando el sync lo
  // trae, el partido de ESPN reemplaza al manual (vínculo y pronósticos incluidos), sin duplicarlo.
  describe("cruce manual del prode que después trae ESPN", () => {
    const H = 3_600_000;
    let espn: typeof matches.$inferSelect;

    // Primer sync para crear liga y equipos; después se borra el partido de ESPN y se carga el manual
    const prepararManual = async (desfaseMs: number) => {
      await sync();
      [espn] = await t.db.select().from(matches);
      await t.DB.prepare("DELETE FROM matches").run();
      await t.db.insert(matches).values({
        id: "manual-1", externalId: "prode:manual-1", homeTeamId: espn.homeTeamId, awayTeamId: espn.awayTeamId, leagueId: espn.leagueId,
        dateTime: new Date(espn.dateTime.getTime() + desfaseMs), status: "scheduled", round: "cuartos", source: "manual",
      });
      await t.db.insert(prodeMatches).values({ matchId: "manual-1", fase: "cuartos", createdAt: AHORA });
      await t.db.insert(users).values({ id: "u1", provider: "google", providerId: "p1", email: "u1@example.test", name: "U1" });
      await t.db.insert(prodePredictions).values({ userId: "u1", matchId: "manual-1", homeGoals: 2, awayGoals: 0, createdAt: AHORA, updatedAt: AHORA });
    };

    it("reemplaza el manual: un solo partido, con el vínculo y los pronósticos", async () => {
      await prepararManual(2 * H);
      expect(await sync()).toMatchObject({ matchesCreated: 1, errors: [] });
      const todos = await t.db.select().from(matches);
      expect(todos).toHaveLength(1);
      expect(todos[0]).toMatchObject({ externalId: espn.externalId, source: espn.source });
      const nuevoId = todos[0].id;
      expect(await t.db.select().from(prodeMatches)).toEqual([expect.objectContaining({ matchId: nuevoId, fase: "cuartos" })]);
      expect(await t.db.select().from(prodePredictions)).toEqual([expect.objectContaining({ userId: "u1", matchId: nuevoId, homeGoals: 2, awayGoals: 0 })]);
      // Un segundo sync no cambia nada
      expect(await sync()).toMatchObject({ matchesCreated: 0, matchesUpdated: 0 });
    });

    it("el resultado a 90 del manual pasa al vínculo del partido de ESPN", async () => {
      await prepararManual(H);
      await t.DB.prepare("UPDATE matches SET status = 'finished', home_score = 1, away_score = 1 WHERE id = 'manual-1'").run();
      await sync();
      expect(await t.db.select().from(prodeMatches)).toEqual([expect.objectContaining({ homeGoals90: 1, awayGoals90: 1 })]);
    });

    it("conserva el evento y su estado para reconciliar el cambio de horario", async () => {
      await prepararManual(H);
      await t.db.insert(users).values({ id: "u2", provider: "google", providerId: "p2", email: "u2@example.test", name: "U2" });
      await t.db.insert(calendarSyncs).values([
        {
          id: "sync-manual", userId: "u1", matchId: "manual-1", provider: "google",
          status: "synced", externalEventId: "evento-manual", syncedState: "scheduled",
          syncedDateTime: new Date(espn.dateTime.getTime() + H),
          previousDateTime: espn.dateTime, dateTimeChangedAt: AHORA,
        },
        { id: "sync-detached", userId: "u2", matchId: "manual-1", provider: "google", status: "detached" },
      ]);
      const anteriores = await t.db.select().from(calendarSyncs);

      expect(await sync()).toMatchObject({ matchesCreated: 1, errors: [] });
      const [nuevo] = await t.db.select().from(matches);
      expect(await t.db.select().from(calendarSyncs)).toEqual(anteriores.map((fila) => ({ ...fila, matchId: nuevo.id })));
      expect(await markOutdatedEvents(t.db, undefined, AHORA)).toBe(1);
      expect(await t.db.select().from(calendarSyncs).where(eq(calendarSyncs.id, "sync-manual"))).toEqual([
        expect.objectContaining({ matchId: nuevo.id, status: "needs_update", externalEventId: "evento-manual" }),
      ]);
      expect(await t.db.select().from(calendarSyncs).where(eq(calendarSyncs.id, "sync-detached"))).toEqual([
        expect.objectContaining({ matchId: nuevo.id, status: "detached" }),
      ]);
    });

    it("conserva el seguimiento de ESPN si ya existe para el mismo usuario", async () => {
      await prepararManual(H);
      await t.db.insert(calendarSyncs).values({
        id: "sync-manual", userId: "u1", matchId: "manual-1", provider: "google",
        status: "synced", externalEventId: "evento-manual",
      });
      await t.DB.prepare(`
        CREATE TRIGGER sync_existente AFTER INSERT ON matches WHEN NEW.source = 'espn'
        BEGIN
          INSERT INTO calendar_syncs (id, user_id, match_id, provider, status, external_event_id)
          VALUES ('sync-espn', 'u1', NEW.id, 'google', 'synced', 'evento-espn');
        END
      `).run();
      try {
        expect(await sync()).toMatchObject({ matchesCreated: 1, errors: [] });
        const [nuevo] = await t.db.select().from(matches);
        expect(await t.db.select().from(calendarSyncs)).toEqual([
          expect.objectContaining({ id: "sync-espn", matchId: nuevo.id, externalEventId: "evento-espn" }),
        ]);
      } finally {
        await t.DB.prepare("DROP TRIGGER sync_existente").run();
      }
    });

    // El admin carga el resultado entre la lectura del sync y el batch del reemplazo
    it("el resultado cargado entre la lectura y el batch del reemplazo pasa al vínculo", async () => {
      await prepararManual(H);
      const d1 = d1ConCambioAntesDelBatch(t.DB, /delete from\s+"?matches/i, () =>
        t.DB.prepare("UPDATE matches SET status = 'finished', home_score = 2, away_score = 1 WHERE id = 'manual-1'").run()
      );
      expect(await syncSingleLeague({ DB: d1 }, "arg.1")).toMatchObject({ matchesCreated: 1, errors: [] });
      expect(await t.db.select().from(matches)).toHaveLength(1);
      expect(await t.db.select().from(prodeMatches)).toEqual([expect.objectContaining({ homeGoals90: 2, awayGoals90: 1 })]);
    });

    // El reemplazo es el único cambio de la corrida: el manual ya empezó (hora pasada, closed_at NULL,
    // como los que entraron por el backfill de 0020) y ESPN lo trae con hora futura a menos de 6 h
    it("un manual empezado se reemplaza cerrado: el de ESPN con hora futura rechaza pronósticos", async () => {
      data.events[0].date = new Date(AHORA.getTime() + 2 * H).toISOString();
      await prepararManual(-3 * H);
      expect(await sync()).toMatchObject({ matchesCreated: 1, matchesUpdated: 0, errors: [] });
      const [nuevo] = await t.db.select().from(matches);
      expect(nuevo.source).toBe(espn.source);
      expect(await t.db.select().from(prodeMatches)).toEqual([expect.objectContaining({ matchId: nuevo.id, closedAt: AHORA.getTime() })]);
      expect(await guardarPronostico(t.db, "u1", { matchId: nuevo.id, homeGoals: 1, awayGoals: 0 })).toMatchObject({ ok: false, status: 409, error: "pronostico_cerrado" });
    });

    it("un manual futuro se reemplaza abierto", async () => {
      data.events[0].date = new Date(AHORA.getTime() + 2 * H).toISOString();
      await prepararManual(H);
      await sync();
      const [nuevo] = await t.db.select().from(matches);
      expect(await t.db.select().from(prodeMatches)).toEqual([expect.objectContaining({ matchId: nuevo.id, closedAt: null })]);
      expect(await guardarPronostico(t.db, "u1", { matchId: nuevo.id, homeGoals: 1, awayGoals: 0 })).toMatchObject({ ok: true });
    });

    it(`reemplaza como máximo ${MAX_REEMPLAZOS_PRODE} por corrida; el resto, en la siguiente`, async () => {
      const total = MAX_REEMPLAZOS_PRODE + 2;
      await prepararManual(H);
      await t.DB.prepare("DELETE FROM prode_predictions").run();
      await t.DB.prepare("DELETE FROM matches").run();
      const base = data.events[0];
      data.events = Array.from({ length: total }, (_, k) => ({ ...structuredClone(base), id: `${base.id}${k}`, date: new Date(AHORA.getTime() + (k + 1) * DIA_MS).toISOString() }));
      for (let k = 0; k < total; k++) {
        await t.db.insert(matches).values({
          id: `manual-${k}`, externalId: `prode:manual-${k}`, homeTeamId: espn.homeTeamId, awayTeamId: espn.awayTeamId, leagueId: espn.leagueId,
          dateTime: new Date(AHORA.getTime() + (k + 1) * DIA_MS + H), status: "scheduled", round: "cuartos", source: "manual",
        });
        await t.db.insert(prodeMatches).values({ matchId: `manual-${k}`, fase: "cuartos", createdAt: AHORA });
      }
      const manualesQuedan = async () => (await t.db.select().from(matches)).filter((m) => m.source === "manual").length;

      expect(await sync()).toMatchObject({ matchesCreated: MAX_REEMPLAZOS_PRODE, errors: [] });
      expect(await manualesQuedan()).toBe(2);
      expect(await t.db.select().from(matches)).toHaveLength(total);
      await sync();
      expect(await manualesQuedan()).toBe(0);
      expect(await t.db.select().from(matches)).toHaveLength(total);
      expect(await t.db.select().from(prodeMatches)).toHaveLength(total);
    });

    it("a 6 h o más es otro partido: no lo reemplaza", async () => {
      await prepararManual(6 * H);
      await sync();
      expect((await t.db.select().from(matches)).map((m) => m.id).sort()).toContain("manual-1");
      expect(await t.db.select().from(matches)).toHaveLength(2);
      expect(await t.db.select().from(prodePredictions)).toEqual([expect.objectContaining({ matchId: "manual-1" })]);
    });

    it("con los equipos invertidos es otro partido: no lo reemplaza", async () => {
      await prepararManual(H);
      await t.DB.prepare("UPDATE matches SET home_team_id = away_team_id, away_team_id = home_team_id WHERE id = 'manual-1'").run();
      await sync();
      expect(await t.db.select().from(matches)).toHaveLength(2);
    });
  });
  // docs/40 D1, D2 y §4.3: el sync lee el resultado de un partido adoptado del prode, lo confirma y no toca lo manual
  describe("resultado automático del prode (docs/40)", () => {
    const H = 3_600_000;
    const MIN = 60_000;
    type Fx = { id: string; status: { type: Record<string, unknown> }; competitors: { homeAway: string; score: string; winner?: boolean; shootoutScore?: number }[] };
    let resumen: unknown = null;
    let pedidosResumen: string[] = [];
    let kv: ReturnType<typeof kvEnMemoria>;

    // Lleva un caso de ESPN real (fixtures espn-prode-*) a la forma del scoreboard de este test: equipos 16 (local) y 5
    const aplicar = (fx: Fx, inicio: number) => {
      const e = data.events[0] as any;
      e.date = new Date(inicio).toISOString();
      e.status = { type: { name: fx.status.type.name, state: fx.status.type.state } };
      e.competitions[0].competitors = fx.competitors.map((c) => ({
        homeAway: c.homeAway, score: c.score, winner: c.winner, shootoutScore: c.shootoutScore,
        team: c.homeAway === "home" ? { id: "16", displayName: "River Plate", abbreviation: "RIV" } : { id: "5", displayName: "Boca Juniors", abbreviation: "BOC" },
      }));
    };
    const resumenDe = (fx: { header: { status: unknown; competitors: any[] } }) => ({
      header: { competitions: [{ status: fx.header.status, competitors: fx.header.competitors.map((c) => ({
        homeAway: c.homeAway, score: c.score, winner: c.winner, shootoutScore: c.shootoutScore, linescores: c.linescores,
        team: { id: c.homeAway === "home" ? "16" : "5" },
      })) }] },
    });
    const FULL_TIME = (prodeFin90 as any[])[0] as Fx;
    const AET = (prodeAlargue as any[]).find((x) => x.id === "761364") as Fx; // 0-0 a los 90', 0-1 a los 120'; pasa el visitante
    const PEN = (prodePenales as any[]).find((x) => x.id === "735663") as Fx; // 0-0, tanda 4-2; pasa el local
    const SUM_AET = (prodeSumAlargue as any[]).find((x) => x.id === "761364");
    const SUM_PEN = (prodeSumPenales as any[]).find((x) => x.id === "735663");

    const vinculo = async () => (await t.db.select().from(prodeMatches))[0];
    const adoptar = async () => {
      const [m] = await t.db.select().from(matches);
      await t.db.insert(prodeMatches).values({ matchId: m.id, fase: "cuartos", createdAt: AHORA });
      return m;
    };
    const syncConKv = () => syncSingleLeague({ DB: t.DB, KV: kv }, "arg.1");
    const enEspera = () => (console.log as any).mock.calls.map((c: string[]) => JSON.parse(c[0])).filter((l: any) => l.msg === "prode_resultado_en_espera");

    beforeEach(() => {
      silenciarConsola(vi);
      kv = kvEnMemoria();
      resumen = null;
      pedidosResumen = [];
      vi.stubGlobal("fetch", vi.fn(async (url: string) => {
        if (String(url).includes("/summary?event=")) {
          pedidosResumen.push(String(url));
          return resumen ? Response.json(resumen) : new Response("{}", { status: 500 });
        }
        return Response.json(data);
      }));
    });

    // Un partido de ESPN ya sincronizado y adoptado, terminado hace `hace` ms
    const preparar = async (fx: Fx, hace = 5 * H) => {
      aplicar(fx, AHORA.getTime() + 2 * H);
      await sync();
      await adoptar();
      aplicar(fx, AHORA.getTime() - hace);
    };

    it("fin en 90' (regla A): una lectura 4 horas o más después del inicio confirma de entrada, sin pedir el summary", async () => {
      await preparar(FULL_TIME);
      await sync();
      const [a, b] = FULL_TIME.competitors.map((c) => Number(c.score));
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: a, autoAwayGoals90: b, autoRegla: "A", autoVistoAt: AHORA.getTime(), autoConfirmadoAt: AHORA.getTime() });
      expect(pedidosResumen).toEqual([]);
    });

    it("lectura reciente: queda visto sin confirmar; una segunda lectura 10 minutos después lo confirma", async () => {
      await preparar(FULL_TIME, 2 * H);
      await sync();
      expect(await vinculo()).toMatchObject({ autoRegla: "A", autoVistoAt: AHORA.getTime(), autoConfirmadoAt: null });

      vi.setSystemTime(AHORA.getTime() + 9 * MIN);
      await sync();
      expect(await vinculo()).toMatchObject({ autoVistoAt: AHORA.getTime(), autoConfirmadoAt: null });

      vi.setSystemTime(AHORA.getTime() + 10 * MIN);
      await sync();
      expect(await vinculo()).toMatchObject({ autoVistoAt: AHORA.getTime(), autoConfirmadoAt: AHORA.getTime() + 10 * MIN });
    });

    it("un valor nuevo reinicia la confirmación", async () => {
      await preparar(FULL_TIME, 2 * H);
      await sync();
      vi.setSystemTime(AHORA.getTime() + 15 * MIN);
      await sync();
      expect((await vinculo()).autoConfirmadoAt).not.toBeNull();

      (data.events[0] as any).competitions[0].competitors[0].score = "7";
      vi.setSystemTime(AHORA.getTime() + 20 * MIN);
      await sync();
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: 7, autoVistoAt: AHORA.getTime() + 20 * MIN, autoConfirmadoAt: null });
    });

    it("una lectura sin resultado (ESPN vuelve a en vivo) vacía las columnas automáticas", async () => {
      await preparar(FULL_TIME);
      await sync();
      expect((await vinculo()).autoConfirmadoAt).not.toBeNull();

      (data.events[0] as any).status.type = { name: "STATUS_IN_PROGRESS", state: "in" };
      await sync();
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: null, autoAwayGoals90: null, autoPasa: null, autoRegla: null, autoVistoAt: null, autoConfirmadoAt: null });
    });

    it("alargue (regla B): pide el summary de ese partido, toma los 90' de los parciales y quién pasa del ganador", async () => {
      await preparar(AET);
      resumen = resumenDe(SUM_AET);
      await sync();
      expect(pedidosResumen).toHaveLength(1);
      expect(pedidosResumen[0]).toMatch(/\/arg\.1\/summary\?event=1$/);
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: 0, autoAwayGoals90: 0, autoPasa: "away", autoRegla: "B", autoConfirmadoAt: AHORA.getTime() });
    });

    it("penales (regla B): 90' de los parciales y pasa el de la tanda", async () => {
      await preparar(PEN);
      resumen = resumenDe(SUM_PEN);
      await sync();
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: 0, autoAwayGoals90: 0, autoPasa: "home", autoRegla: "B" });
    });

    it("una vez confirmado y sin cambios, el siguiente sync no vuelve a pedir el summary", async () => {
      await preparar(AET);
      resumen = resumenDe(SUM_AET);
      await sync();
      pedidosResumen = [];
      await sync();
      expect(pedidosResumen).toEqual([]);
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: 0, autoPasa: "away", autoConfirmadoAt: AHORA.getTime() });
    });

    it("sin summary (ESPN falla): en espera con motivo, el sync no falla y solo guarda lo que asegura", async () => {
      await preparar(AET);
      resumen = null;
      expect(await sync()).toMatchObject({ errors: [] });
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: null, autoAwayGoals90: null, autoPasa: "away" });
      expect(enEspera()).toEqual([expect.objectContaining({ estadoProveedor: "STATUS_FINAL_AET", motivo: "parciales_incompletos" })]);
    });

    it("parciales que no cierran con el marcador: en espera con motivo parciales_no_cierran", async () => {
      await preparar(AET);
      const roto = structuredClone(resumenDe(SUM_AET)) as any;
      roto.header.competitions[0].competitors[1].linescores[3].displayValue = "3";
      resumen = roto;
      await sync();
      expect((await vinculo()).autoHomeGoals90).toBeNull();
      expect(enEspera()).toEqual([expect.objectContaining({ motivo: "parciales_no_cierran" })]);
    });

    // Sintético: cuatro cruces con alargue en la misma liga, para ejercitar el presupuesto de subrequests (docs/22)
    const cuatroConAlargue = async () => {
      aplicar(AET, AHORA.getTime() + 2 * H);
      const base = data.events[0];
      data.events = [1, 2, 3, 4].map((n) => ({ ...structuredClone(base), id: String(n), date: new Date(AHORA.getTime() + n * DIA_MS).toISOString() }));
      await sync();
      const filas = await t.db.select().from(matches);
      await t.db.insert(prodeMatches).values(filas.map((m) => ({ matchId: m.id, fase: "cuartos", createdAt: AHORA })));
      data.events.forEach((e, n) => (e.date = new Date(AHORA.getTime() - (n + 1) * DIA_MS).toISOString()));
    };

    it("pide como mucho MAX_RESUMENES_PRODE summaries por invocación; el resto queda en espera (sintético)", async () => {
      await cuatroConAlargue();
      resumen = resumenDe(SUM_AET);
      expect(await sync()).toMatchObject({ errors: [] });
      expect(pedidosResumen).toHaveLength(MAX_RESUMENES_PRODE);
      const vinculos = await t.db.select().from(prodeMatches);
      expect(vinculos.filter((v) => v.autoHomeGoals90 !== null)).toHaveLength(MAX_RESUMENES_PRODE);
      expect(enEspera()).toEqual([expect.objectContaining({ motivo: "parciales_incompletos" })]);

      // La corrida siguiente atiende el que quedó
      pedidosResumen = [];
      await sync();
      expect(pedidosResumen).toHaveLength(1);
    });

    // Con el tope agotado por partidos viejos que nunca cierran, los recién terminados no pueden quedar sin summary
    it("gasta el tope de summaries en los partidos más recientes, venga como venga la lista (sintético)", async () => {
      await cuatroConAlargue();
      resumen = resumenDe(SUM_AET);
      data.events.reverse(); // del más viejo (4) al más nuevo (1)
      await sync();
      expect(pedidosResumen.map((url) => new URL(url).searchParams.get("event"))).toEqual(["1", "2", "3"]);
    });

    it("si un summary falla no pide los siguientes en esa invocación (sintético)", async () => {
      await cuatroConAlargue();
      resumen = null;
      expect(await sync()).toMatchObject({ errors: [] });
      expect(new Set(pedidosResumen).size).toBe(1);
    });

    it("estado fuera de la lista blanca (sintético: resultado administrativo): nada automático y motivo estado_desconocido", async () => {
      await preparar(FULL_TIME);
      (data.events[0] as any).status.type = { name: "STATUS_FORFEIT", state: "post" };
      await sync();
      expect(await vinculo()).toMatchObject({ autoHomeGoals90: null, autoPasa: null, autoRegla: null, autoConfirmadoAt: null });
      expect(enEspera()).toEqual([expect.objectContaining({ estadoProveedor: "STATUS_FORFEIT", motivo: "estado_desconocido" })]);
    });

    it("un dato visto pero sin confirmar se loguea en espera con motivo sin_confirmar (sintético: lectura reciente)", async () => {
      await preparar(FULL_TIME, 2 * H);
      await sync();
      expect(enEspera()).toEqual([expect.objectContaining({ estadoProveedor: "STATUS_FULL_TIME", motivo: "sin_confirmar" })]);
    });

    it("nunca escribe las columnas manuales", async () => {
      await preparar(FULL_TIME);
      await t.DB.prepare("UPDATE prode_matches SET home_goals_90 = 4, away_goals_90 = 4, pasa = 'away'").run();
      await sync();
      expect(await vinculo()).toMatchObject({ homeGoals90: 4, awayGoals90: 4, pasa: "away", autoRegla: "A" });
    });

    it("un partido sin vínculo del prode no escribe nada del prode ni lee el KV", async () => {
      const get = vi.spyOn(kv, "get");
      aplicar(FULL_TIME, AHORA.getTime() + 2 * H);
      await sync();
      aplicar(FULL_TIME, AHORA.getTime() - 5 * H);
      await syncConKv();
      expect(get).not.toHaveBeenCalled();
      expect(await t.db.select().from(prodeMatches)).toEqual([]);
    });

    it("escribe en el mismo batch: con un partido del prode no suma viajes a D1", async () => {
      const contar = () => {
        let viajes = 0;
        const DB = new Proxy(t.DB, {
          get(target, prop) {
            if (prop === "batch") return (...a: unknown[]) => (viajes++, (target.batch as any)(...a));
            const v = Reflect.get(target, prop);
            return typeof v === "function" ? v.bind(target) : v;
          },
        });
        return { DB, viajes: () => viajes };
      };
      aplicar(FULL_TIME, AHORA.getTime() + 2 * H);
      await sync();
      aplicar(FULL_TIME, AHORA.getTime() - 5 * H);
      const sin = contar();
      await syncSingleLeague({ DB: sin.DB }, "arg.1");

      // Mismo cambio de ESPN, pero con el partido adoptado
      await t.DB.prepare("UPDATE matches SET status = 'scheduled', home_score = NULL, away_score = NULL, date_time = ?").bind(Math.floor((AHORA.getTime() + 2 * H) / 1000)).run();
      await adoptar();
      const con = contar();
      await syncSingleLeague({ DB: con.DB }, "arg.1");
      expect((await vinculo()).autoRegla).toBe("A");
      expect(con.viajes()).toBe(sin.viajes());
    });

    // Los pronósticos se cargaron sobre los equipos guardados: otro orden u otro equipo no puede puntuar
    describe("ESPN cambia los equipos de un adoptado", () => {
      const SIN_AUTO = { autoHomeGoals90: null, autoAwayGoals90: null, autoPasa: null, autoRegla: null, autoVistoAt: null, autoConfirmadoAt: null };
      const guardado = async () => (await t.db.select().from(matches))[0];
      const invertir = () => {
        for (const c of (data.events[0] as any).competitions[0].competitors) c.homeAway = c.homeAway === "home" ? "away" : "home";
      };
      const cambiarRival = () => {
        (data.events[0] as any).competitions[0].competitors[1].team = { id: "999", displayName: "Otro Club", abbreviation: "OTR" };
      };

      it.each([["local y visitante invertidos", invertir], ["un equipo distinto", cambiarRival]])(
        "%s: ni marcador ni equipos ni dato automático, y queda en espera (sintético)",
        async (_caso, cambiar) => {
          await preparar(FULL_TIME);
          const antes = await guardado();
          cambiar();
          expect(await sync()).toMatchObject({ errors: [] });
          expect(await guardado()).toMatchObject({ homeTeamId: antes.homeTeamId, awayTeamId: antes.awayTeamId, status: "finished", homeScore: null, awayScore: null });
          expect(await vinculo()).toMatchObject(SIN_AUTO);
          expect(enEspera()).toEqual([expect.objectContaining({ motivo: "equipos_no_coinciden" })]);
        }
      );

      it("vacía lo ya confirmado, incluso con el KV en off, sin tocar lo manual (sintético)", async () => {
        await preparar(FULL_TIME);
        await syncConKv();
        expect((await vinculo()).autoConfirmadoAt).not.toBeNull();
        await t.DB.prepare("UPDATE prode_matches SET home_goals_90 = 4, away_goals_90 = 4, pasa = 'away'").run();
        await kv.put("prode:resultado_auto", "off");
        invertir();
        await syncConKv();
        expect(await vinculo()).toMatchObject({ ...SIN_AUTO, homeGoals90: 4, awayGoals90: 4, pasa: "away" });
      });
    });

    describe("resumen caído o incompleto", () => {
      it("sin los dos goles nunca se confirma, aunque la lectura sea tardía (sintético)", async () => {
        await preparar(AET);
        await sync();
        vi.setSystemTime(AHORA.getTime() + 15 * MIN);
        await sync();
        expect(await vinculo()).toMatchObject({ autoHomeGoals90: null, autoPasa: "away", autoVistoAt: AHORA.getTime(), autoConfirmadoAt: null });
      });

      it("no pisa goles ya vistos si el summary falla y el scoreboard no cambió; la lectura siguiente confirma", async () => {
        await preparar(AET, 2 * H);
        resumen = resumenDe(SUM_AET);
        await sync();
        const visto = await vinculo();
        expect(visto).toMatchObject({ autoHomeGoals90: 0, autoConfirmadoAt: null });

        resumen = null;
        vi.setSystemTime(AHORA.getTime() + 15 * MIN);
        await sync();
        expect(await vinculo()).toEqual(visto);
        // Un summary que responde pero no cierra tampoco los pisa ni los confirma
        const roto = structuredClone(resumenDe(SUM_AET)) as any;
        roto.header.competitions[0].competitors[1].linescores[3].displayValue = "3";
        resumen = roto;
        await sync();
        expect(await vinculo()).toEqual(visto);

        resumen = resumenDe(SUM_AET);
        vi.setSystemTime(AHORA.getTime() + DIA_MS);
        await sync();
        expect(await vinculo()).toMatchObject({ autoHomeGoals90: 0, autoPasa: "away", autoConfirmadoAt: AHORA.getTime() + DIA_MS });
      });

      it("si el scoreboard cambió, los goles viejos no se conservan (sintético)", async () => {
        await preparar(AET, 2 * H);
        resumen = resumenDe(SUM_AET);
        await sync();
        resumen = null;
        const competidores = (data.events[0] as any).competitions[0].competitors;
        for (const c of competidores) c.winner = !c.winner;
        await sync();
        expect((await vinculo()).autoHomeGoals90).toBeNull();
      });
    });

    describe("confirmación tardía (docs/40 §4.3 y §6)", () => {
      const cambiarMarcador = () => {
        (data.events[0] as any).competitions[0].competitors[0].score = "7";
      };

      it("un valor cambiado exige una segunda lectura, aunque pasen más de 4 horas; la trae el sync siguiente", async () => {
        await preparar(FULL_TIME);
        await sync();
        expect((await vinculo()).autoConfirmadoAt).not.toBeNull();

        cambiarMarcador();
        vi.setSystemTime(AHORA.getTime() + DIA_MS);
        await sync();
        expect(await vinculo()).toMatchObject({ autoHomeGoals90: 7, autoVistoAt: AHORA.getTime() + DIA_MS, autoConfirmadoAt: null });

        vi.setSystemTime(AHORA.getTime() + 2 * DIA_MS);
        await sync();
        expect((await vinculo()).autoConfirmadoAt).toBe(AHORA.getTime() + 2 * DIA_MS);
      });

      it("un partido que la lectura anterior vio en vivo exige dos lecturas", async () => {
        await preparar(FULL_TIME);
        await t.DB.prepare("UPDATE matches SET status = 'live'").run();
        await sync();
        expect(await vinculo()).toMatchObject({ autoVistoAt: AHORA.getTime(), autoConfirmadoAt: null });
        vi.setSystemTime(AHORA.getTime() + 10 * MIN);
        await sync();
        expect((await vinculo()).autoConfirmadoAt).toBe(AHORA.getTime() + 10 * MIN);
      });
    });

    describe("interruptor KV prode:resultado_auto (docs/40 D3)", () => {
      it("sin clave equivale a on", async () => {
        await preparar(FULL_TIME);
        await syncConKv();
        expect((await vinculo()).autoRegla).toBe("A");
      });

      it("off: no escribe ni confirma datos automáticos (tampoco vacía los que ya había)", async () => {
        await preparar(FULL_TIME);
        await syncConKv();
        const antes = await vinculo();
        await kv.put("prode:resultado_auto", "off");
        (data.events[0] as any).competitions[0].competitors[0].score = "9";
        await syncConKv();
        expect(await vinculo()).toEqual(antes);
        (data.events[0] as any).status.type = { name: "STATUS_IN_PROGRESS", state: "in" };
        await syncConKv();
        expect(await vinculo()).toEqual(antes);
      });

      it("off desde el principio: no escribe nada automático", async () => {
        await preparar(FULL_TIME);
        await kv.put("prode:resultado_auto", "off");
        await syncConKv();
        expect(await vinculo()).toMatchObject({ autoHomeGoals90: null, autoRegla: null, autoVistoAt: null });
      });

      it("solo-b: no escribe la regla A", async () => {
        await preparar(FULL_TIME);
        await kv.put("prode:resultado_auto", "solo-b");
        await syncConKv();
        expect(await vinculo()).toMatchObject({ autoRegla: null, autoHomeGoals90: null });
      });

      it("solo-a: escribe la regla A y no pide el summary de la regla B", async () => {
        await kv.put("prode:resultado_auto", "solo-a");
        await preparar(FULL_TIME);
        await syncConKv();
        expect((await vinculo()).autoRegla).toBe("A");
        await t.DB.prepare("UPDATE prode_matches SET auto_home_goals_90 = NULL, auto_away_goals_90 = NULL, auto_pasa = NULL, auto_regla = NULL, auto_visto_at = NULL, auto_confirmado_at = NULL").run();
        aplicar(AET, AHORA.getTime() - 5 * H);
        resumen = resumenDe(SUM_AET);
        await syncConKv();
        expect(pedidosResumen).toEqual([]);
        expect((await vinculo()).autoRegla).toBeNull();
      });

      it("solo-b: escribe la regla B", async () => {
        await kv.put("prode:resultado_auto", "solo-b");
        await preparar(AET);
        resumen = resumenDe(SUM_AET);
        await syncConKv();
        expect(await vinculo()).toMatchObject({ autoRegla: "B", autoPasa: "away" });
      });

      it("un valor desconocido o un KV caído se trata como off (lo conservador)", async () => {
        await preparar(FULL_TIME);
        await kv.put("prode:resultado_auto", "quizas");
        await syncConKv();
        expect((await vinculo()).autoRegla).toBeNull();
        kv.get = async () => { throw new Error("KV caído"); };
        expect(await syncConKv()).toMatchObject({ errors: [] });
        expect((await vinculo()).autoRegla).toBeNull();
      });

      it("se lee una sola vez por invocación", async () => {
        await preparar(FULL_TIME);
        const get = vi.spyOn(kv, "get");
        await syncConKv();
        expect(get).toHaveBeenCalledTimes(1);
      });
    });
  });
});
