// URLs con nombre de equipos y ligas (docs/33 D9): backfill por lotes, asignación en el sync y búsqueda
// por slug o por id, contra una D1 efímera.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import scoreboard from "../../fixtures/espn-scoreboard.json";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { leagues, teams } from "../../../drizzle/schema";
import { asignarSlugsPendientes, contarPendientes, slugsOcupados } from "../../../src/lib/db/slugs";
import { getLeagueBySlugOrId, getPaginasPublicas, getTeamBySlugOrId } from "../../../src/lib/db/queries";
import { syncSingleLeague } from "../../../src/lib/data-providers/sync";
import { POST } from "../../../src/pages/api/admin/slugs";

const ADMIN = "admin-de-prueba";

describe("slugs de equipos y ligas", () => {
  const t = useTestDb();

  const liga = (id: string, name: string, country = "Argentina", slug: string | null = null) =>
    t.db.insert(leagues).values({ id, externalId: `x:${id}`, name, country, season: 2026, source: "espn", slug });
  const equipo = (id: string, name: string, country: string | null = null, slug: string | null = null, leagueId = "l1") =>
    t.db.insert(teams).values({ id, externalId: `x:${id}`, name, country, leagueId, source: "espn", slug });
  const slugDe = async (id: string) => (await t.db.select({ slug: teams.slug }).from(teams).where(eq(teams.id, id)))[0]?.slug;

  describe("backfill (asignarSlugsPendientes)", () => {
    beforeEach(async () => {
      await liga("l1", "Liga Profesional Argentina");
    });

    it("asigna slugs a ligas y equipos sin slug, con tildes, puntos y apóstrofes", async () => {
      await equipo("a", "Atlético Tucumán", "Argentina");
      await equipo("b", "O'Higgins", "Chile");
      await equipo("c", "1. FC Köln", "Alemania");
      const r = await asignarSlugsPendientes(t.db);
      expect(r).toEqual({ asignados: { ligas: 1, equipos: 3 }, pendientes: 0, pendientesPorTabla: { ligas: 0, equipos: 0 } });
      expect(await slugDe("a")).toBe("atletico-tucuman");
      expect(await slugDe("b")).toBe("ohiggins");
      expect(await slugDe("c")).toBe("1-fc-koln");
      expect((await t.db.select().from(leagues))[0].slug).toBe("liga-profesional-argentina");
    });

    it("resuelve nombres repetidos con el país y después con un número, por orden de alta", async () => {
      await equipo("z-primero", "Liverpool", "Inglaterra");
      await equipo("a-segundo", "Liverpool", "Uruguay");
      await equipo("m-tercero", "Liverpool", null);
      await asignarSlugsPendientes(t.db);
      expect(await slugDe("z-primero")).toBe("liverpool");
      expect(await slugDe("a-segundo")).toBe("liverpool-uruguay");
      expect(await slugDe("m-tercero")).toBe("liverpool-2");
    });

    it("no choca con slugs ya asignados ni con ids de otras filas", async () => {
      await equipo("river", "River Plate", "Argentina", "river");
      await equipo("t2", "River", "Uruguay");
      await equipo("t3", "River Plate", "Argentina");
      await asignarSlugsPendientes(t.db);
      // "river" es el slug (y el id) de otra fila
      expect(await slugDe("t2")).toBe("river-uruguay");
      expect(await slugDe("t3")).toBe("river-plate");
    });

    it("procesa de a lotes acotados hasta pendientes 0 y es idempotente", async () => {
      for (let i = 0; i < 5; i++) await equipo(`e${i}`, `Equipo ${i}`);
      expect(await asignarSlugsPendientes(t.db, 4)).toMatchObject({ asignados: { ligas: 1, equipos: 3 }, pendientes: 2 });
      expect(await asignarSlugsPendientes(t.db, 4)).toMatchObject({ asignados: { ligas: 0, equipos: 2 }, pendientes: 0 });
      const antes = await t.db.select({ id: teams.id, slug: teams.slug }).from(teams);
      expect(await asignarSlugsPendientes(t.db, 4)).toMatchObject({ asignados: { ligas: 0, equipos: 0 }, pendientes: 0 });
      expect(await t.db.select({ id: teams.id, slug: teams.slug }).from(teams)).toEqual(antes);
    });

    it("un slug asignado no cambia aunque cambie el nombre", async () => {
      await equipo("a", "Atlético Tucumán", null, "atletico-tucuman");
      await t.db.update(teams).set({ name: "Club Atlético Tucumán" }).where(eq(teams.id, "a"));
      await asignarSlugsPendientes(t.db);
      expect(await slugDe("a")).toBe("atletico-tucuman");
    });

    it("un nombre sin letras ni números no recibe slug y no cuenta como pendiente", async () => {
      await equipo("raro", "北京国安");
      expect(await asignarSlugsPendientes(t.db)).toMatchObject({ asignados: { ligas: 1, equipos: 0 }, pendientes: 0 });
      expect(await slugDe("raro")).toBeNull();
      expect(await contarPendientes(t.db)).toEqual({ ligas: 0, equipos: 0 });
    });

    it("las rutas fijas y la forma de UUID no se usan como slug", async () => {
      await equipo("t1", "Buscar", "Argentina");
      await equipo("t2", "123e4567-e89b-12d3-a456-426614174000");
      await asignarSlugsPendientes(t.db);
      expect(await slugDe("t1")).toBe("buscar-argentina");
      expect(await slugDe("t2")).toBe("123e4567-e89b-12d3-a456-426614174000-2");
    });

    it("la consulta de ocupados lee solo las variantes del slug base", async () => {
      await equipo("t1", "River", null, "river");
      await equipo("t2", "River 2", null, "river-2");
      await equipo("t3", "Riverside", null, "riverside");
      expect(await slugsOcupados(t.db, "teams", ["river"])).toEqual(new Set(["t1", "river", "t2", "river-2"]));
      // 30 bases: más de un lote de consulta (25 por sentencia por el tope de 100 parámetros)
      const muchas = Array.from({ length: 30 }, (_, i) => `base-${i}`);
      expect(await slugsOcupados(t.db, "teams", muchas)).toEqual(new Set());
    });
  });

  describe("búsqueda por slug o por id", () => {
    beforeEach(async () => {
      await liga("l1", "Liga Profesional Argentina", "Argentina", "liga-profesional-argentina");
      await equipo("uuid-river", "River Plate", "Argentina", "river-plate");
      await equipo("uuid-sin", "Sin slug");
    });

    it("encuentra el equipo por slug y por id, y null si no existe", async () => {
      expect((await getTeamBySlugOrId(t.db, "river-plate"))?.id).toBe("uuid-river");
      expect((await getTeamBySlugOrId(t.db, "uuid-river"))?.slug).toBe("river-plate");
      expect((await getTeamBySlugOrId(t.db, "uuid-sin"))?.slug).toBeNull();
      expect(await getTeamBySlugOrId(t.db, "no-existe")).toBeNull();
    });

    it("si el slug de una fila es el id de otra, gana la del slug", async () => {
      await equipo("river-plate", "Otro River");
      expect((await getTeamBySlugOrId(t.db, "river-plate"))?.id).toBe("uuid-river");
    });

    it("encuentra la liga por slug y por id", async () => {
      expect((await getLeagueBySlugOrId(t.db, "liga-profesional-argentina"))?.id).toBe("l1");
      expect((await getLeagueBySlugOrId(t.db, "l1"))?.slug).toBe("liga-profesional-argentina");
      expect(await getLeagueBySlugOrId(t.db, "no-existe")).toBeNull();
    });

    it("el sitemap trae el slug de ligas y equipos", async () => {
      await t.db.update(leagues).set({ isFeatured: true, isActive: true });
      const { ligas } = await getPaginasPublicas(t.db);
      expect(ligas).toEqual([expect.objectContaining({ id: "l1", slug: "liga-profesional-argentina" })]);
    });
  });

  describe("sync (equipos y ligas nuevos)", () => {
    let data: typeof scoreboard;
    relojFijo();
    beforeEach(() => {
      data = structuredClone(scoreboard);
      data.events[0].date = new Date(AHORA.getTime() + DIA_MS).toISOString();
      data.events[0].season.year = AHORA.getUTCFullYear();
      vi.stubGlobal("fetch", vi.fn(async () => Response.json(data)));
    });
    const sync = (leagueId = "arg.1") => syncSingleLeague({ DB: t.DB }, leagueId);

    it("asigna slug a la liga y a los equipos que crea", async () => {
      expect(await sync()).toMatchObject({ teamsCreated: 2, errors: [] });
      const equipos = await t.db.select({ name: teams.name, slug: teams.slug }).from(teams).orderBy(teams.name);
      expect(equipos).toEqual([{ name: "Boca Juniors", slug: "boca-juniors" }, { name: "River Plate", slug: "river-plate" }]);
      const [l] = await t.db.select().from(leagues).where(eq(leagues.externalId, "arg.1"));
      expect(l.slug).toBe("liga-profesional-argentina");
    });

    it("un equipo nuevo con el nombre de otro ya existente recibe el país o un número", async () => {
      await liga("otra", "Otra liga", "Uruguay");
      await equipo("viejo", "River Plate", "Uruguay", "river-plate", "otra");
      await sync();
      const [nuevo] = await t.db.select().from(teams).where(eq(teams.externalId, "espn:16"));
      expect(nuevo.slug).toBe("river-plate-argentina");
    });

    it("no cambia el slug de un equipo existente aunque cambie el nombre, ni asigna a los existentes sin slug", async () => {
      await sync();
      await t.db.update(teams).set({ slug: null }).where(eq(teams.externalId, "espn:5"));
      data.events[0].competitions[0].competitors[1].team.displayName = "River Plate actualizado";
      expect(await sync()).toMatchObject({ teamsUpdated: 1, errors: [] });
      const filas = await t.db.select({ externalId: teams.externalId, name: teams.name, slug: teams.slug }).from(teams).orderBy(teams.externalId);
      expect(filas).toEqual([
        { externalId: "espn:16", name: "River Plate actualizado", slug: "river-plate" },
        { externalId: "espn:5", name: "Boca Juniors", slug: null },
      ]);
    });

    it("una liga existente sin slug (anterior al backfill) lo recibe en el sync; con slug no se toca", async () => {
      await sync();
      await t.db.update(leagues).set({ slug: null }).where(eq(leagues.externalId, "arg.1"));
      await sync();
      const [l] = await t.db.select().from(leagues).where(eq(leagues.externalId, "arg.1"));
      expect(l.slug).toBe("liga-profesional-argentina");
      await t.db.update(leagues).set({ slug: "slug-viejo" }).where(eq(leagues.externalId, "arg.1"));
      await sync();
      expect((await t.db.select().from(leagues).where(eq(leagues.externalId, "arg.1")))[0].slug).toBe("slug-viejo");
    });

    it("si asignar el slug de la liga falla, el sync termina igual y la liga sigue por id", async () => {
      silenciarConsola(vi);
      await t.DB.prepare("CREATE TRIGGER falla_slug BEFORE UPDATE OF slug ON leagues BEGIN SELECT RAISE(ABORT, 'falla simulada'); END").run();
      try {
        expect(await sync()).toMatchObject({ teamsCreated: 2, errors: [] });
        expect((await t.db.select().from(leagues).where(eq(leagues.externalId, "arg.1")))[0].slug).toBeNull();
      } finally {
        await t.DB.prepare("DROP TRIGGER falla_slug").run();
      }
    });
  });

  describe("POST /api/admin/slugs", () => {
    beforeEach(async () => {
      silenciarConsola(vi);
      await liga("l1", "Liga Profesional Argentina");
      await equipo("a", "Atlético Tucumán");
    });

    const llamar = async (auth: string | null = `Bearer ${ADMIN}`) => {
      const res = await POST(
        apiCtx({
          url: "https://fisture.test/api/admin/slugs",
          method: "POST",
          headers: auth === null ? {} : { Authorization: auth },
          env: { ENVIRONMENT: "test", DB: t.DB, KV: kvEnMemoria(), ADMIN_SECRET: ADMIN },
        })
      );
      return { status: res.status, body: (await res.json()) as any, headers: res.headers };
    };

    it("sin Bearer o con uno incorrecto responde 401 y no toca la base", async () => {
      for (const auth of [null, "Bearer otro"]) expect((await llamar(auth)).status).toBe(401);
      expect(await slugDe("a")).toBeNull();
    });

    it("asigna, responde los conteos sin nombres y repetido queda en pendientes 0", async () => {
      const primera = await llamar();
      expect(primera.status).toBe(200);
      expect(primera.headers.get("Cache-Control")).toBe("no-store");
      expect(primera.body).toEqual({ asignados: { ligas: 1, equipos: 1 }, pendientes: 0, pendientesPorTabla: { ligas: 0, equipos: 0 } });
      expect(await slugDe("a")).toBe("atletico-tucuman");
      expect((await llamar()).body).toMatchObject({ asignados: { ligas: 0, equipos: 0 }, pendientes: 0 });
    });
  });
});
