import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import scoreboard from "../fixtures/espn-scoreboard.json";
import { useTestDb } from "../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../helpers/clock";
import { MAX_REEMPLAZOS_PRODE, syncLote, syncSingleLeague } from "../../src/lib/data-providers/sync";
import { LEAGUES_CONFIG, lotesDeSync } from "../../src/lib/data-providers";
import { guardarPronostico, listarPronosticos } from "../../src/lib/prode/pronosticos";
import { leagues, teams, matches, leagueTeams, prodeMatches, prodePredictions, users } from "../../drizzle/schema";

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
});
