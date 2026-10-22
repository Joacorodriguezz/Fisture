// Complementa tests/integration/api.test.ts con los bordes de los endpoints de equipos
// (ids ausentes, aislamiento entre usuarios, búsqueda) que ese archivo no recorre.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { callApi } from "../../helpers/api";
import { silenciarConsola } from "../../helpers/ctx";
import { teams, userTeams } from "../../../drizzle/schema";
import { POST as seguirEquipo } from "../../../src/pages/api/equipos/index";
import { DELETE as dejar, PATCH as configurar } from "../../../src/pages/api/equipos/[id]";
import { GET as buscar } from "../../../src/pages/api/equipos/buscar";

describe("endpoints de equipos: bordes", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  relojFijo();

  beforeEach(async () => {
    silenciarConsola(vi);
    fixtures = await seedApp(t.db);
  });

  const seguir = (teamId: string, userId = fixtures.user.id) => t.db.insert(userTeams).values({ userId, teamId });
  const siguiendo = async (userId = fixtures.user.id) =>
    (await t.db.select().from(userTeams)).filter((ut) => ut.userId === userId).map((ut) => [ut.teamId, ut.autoSync]);

  describe("POST", () => {
    it("el cuerpo sin teamId responde 400 con su mensaje", async () => {
      const res = await callApi(seguirEquipo, t.DB, { user: fixtures.user, method: "POST", body: {} });
      expect(await res.json()).toEqual({ error: "teamId is required" });
    });

    it("un cuerpo que no es JSON responde 400", async () => {
      const res = await callApi(seguirEquipo, t.DB, { user: fixtures.user, method: "POST", rawBody: "{no es json" });
      expect(res.status).toBe(400);
    });

    it("dos usuarios pueden seguir el mismo equipo", async () => {
      await seguir("river", fixtures.user.id);
      const res = await callApi(seguirEquipo, t.DB, { user: fixtures.other, method: "POST", body: { teamId: "river" } });
      expect(res.status).toBe(201);
    });

    it("un equipo inexistente no deja filas", async () => {
      await callApi(seguirEquipo, t.DB, { user: fixtures.user, method: "POST", body: { teamId: "fantasma" } });
      expect(await siguiendo()).toEqual([]);
    });
  });

  describe("DELETE", () => {
    it("sin id de equipo responde 400", async () => {
      expect((await callApi(dejar, t.DB, { user: fixtures.user })).status).toBe(400);
    });

    it("un equipo que no se sigue responde 404", async () => {
      expect((await callApi(dejar, t.DB, { user: fixtures.user, params: { id: "river" } })).status).toBe(404);
    });

    it("deja de seguir solo el equipo indicado y solo para ese usuario", async () => {
      await seguir("river");
      await seguir("boca");
      await seguir("river", fixtures.other.id);

      await callApi(dejar, t.DB, { user: fixtures.user, params: { id: "river" } });

      expect(await siguiendo(fixtures.user.id)).toEqual([["boca", true]]);
      expect(await siguiendo(fixtures.other.id)).toEqual([["river", true]]);
    });
  });

  describe("PATCH", () => {
    it("sin id de equipo responde 400", async () => {
      const res = await callApi(configurar, t.DB, { user: fixtures.user, method: "PATCH", body: { autoSync: false } });
      expect(res.status).toBe(400);
    });

    it("un equipo que no se sigue responde 404", async () => {
      const res = await callApi(configurar, t.DB, { user: fixtures.user, method: "PATCH", params: { id: "river" }, body: { autoSync: false } });
      expect(res.status).toBe(404);
    });

    it("un JSON inválido responde 400", async () => {
      await seguir("river");
      const res = await callApi(configurar, t.DB, { user: fixtures.user, method: "PATCH", params: { id: "river" }, rawBody: "{no es json" });
      expect(res.status).toBe(400);
    });

    it("no modifica el equipo de otro usuario", async () => {
      await seguir("river", fixtures.other.id);
      const res = await callApi(configurar, t.DB, { user: fixtures.user, method: "PATCH", params: { id: "river" }, body: { autoSync: false } });
      expect(res.status).toBe(404);
      expect(await siguiendo(fixtures.other.id)).toEqual([["river", true]]);
    });
  });

  describe("GET /buscar", () => {
    const consultar = async (q: string | null, user: typeof fixtures.user | undefined = undefined) =>
      (await callApi(buscar, t.DB, { user, path: `/api/equipos/buscar${q === null ? "" : `?q=${encodeURIComponent(q)}`}` })).json();

    it.each([[null], [""], ["  "], [" r "]])("la consulta %j (menos de 2 caracteres útiles) devuelve una lista vacía", async (q) => {
      expect(await consultar(q)).toEqual([]);
    });

    it("encuentra por coincidencia parcial sin distinguir mayúsculas e incluye la liga", async () => {
      expect(await consultar("JUNIORS")).toEqual([expect.objectContaining({ id: "boca", name: "Boca Juniors", league: { id: "test-league", name: "Liga de prueba" } })]);
    });

    it("una consulta sin coincidencias devuelve una lista vacía", async () => {
      expect(await consultar("zzz")).toEqual([]);
    });

    it("es pública: sin sesión isFollowing es false", async () => {
      expect(await consultar("boca")).toEqual([expect.objectContaining({ isFollowing: false })]);
    });

    it("con sesión marca isFollowing solo en los equipos que sigue", async () => {
      await t.db.insert(teams).values({ id: "boca-unidos", externalId: "test:boca-unidos", name: "Boca Unidos", leagueId: "test-league" });
      await seguir("boca");
      const lista = (await consultar("boca", fixtures.user)) as { id: string; isFollowing: boolean }[];
      expect(Object.fromEntries(lista.map((e) => [e.id, e.isFollowing]))).toEqual({ boca: true, "boca-unidos": false });
    });

    it("limita los resultados a 20", async () => {
      // D1 admite pocas variables por consulta: se inserta de a un equipo
      for (let i = 0; i < 25; i++) await t.db.insert(teams).values({ id: `x${i}`, externalId: `e-x${i}`, name: `Club Atlético ${i}`, leagueId: "test-league" });
      expect(await consultar("atlético")).toHaveLength(20);
    });

    // Defecto conocido: los comodines de LIKE no se escapan, así que q=%% devuelve todos los equipos.
    it.todo("los comodines LIKE (% y _) de la consulta deberían escaparse");
  });
});
