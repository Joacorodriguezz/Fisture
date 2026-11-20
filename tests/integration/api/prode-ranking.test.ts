// Rankings del prode (docs/37 §6): general, por fase y por grupo privado. Los puntos se calculan al
// leer (puntosPorUsuario), así que corregir un resultado reordena la tabla sin pasos extra.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import { callApi } from "../../helpers/api";
import { silenciarConsola } from "../../helpers/ctx";
import { matches, prodeGroupMembers, prodeGroups, prodeMatches, prodePredictions, users, type User } from "../../../drizzle/schema";
import { rankingProde } from "../../../src/lib/prode/ranking";
import { GET as GET_GENERAL } from "../../../src/pages/api/prode/ranking";
import { GET as GET_GRUPO } from "../../../src/pages/api/prode/grupos/[id]/ranking";

const AYER = new Date(AHORA.getTime() - DIA_MS);

describe("rankings del prode", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  relojFijo();

  const cruce = (id: string, round: string, home: number, away: number) => ({
    id, externalId: `prode:${id}`, homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league",
    dateTime: AYER, status: "finished", round, source: "manual", homeScore: home, awayScore: away,
  });
  const pronostico = (userId: string, matchId: string, homeGoals: number, awayGoals: number) =>
    ({ userId, matchId, homeGoals, awayGoals, createdAt: AYER, updatedAt: AYER });
  const usuario = (id: string, displayName: string | null) =>
    ({ id, provider: "google", providerId: `provider-${id}`, email: `${id}@example.test`, name: `Nombre ${id}`, displayName });
  const resumen = (filas: { posicion: number; nombre: string; puntos: number }[]) => filas.map((f) => [f.posicion, f.nombre, f.puntos]);

  beforeEach(async () => {
    silenciarConsola(vi);
    fixtures = await seedApp(t.db);
    await t.DB.prepare("UPDATE users SET display_name = CASE id WHEN 'user-1' THEN 'Ana' ELSE 'Luis' END").run();
    await t.db.insert(users).values([usuario("user-3", "Zoe"), usuario("user-4", "beto"), usuario("user-5", "Álvaro"), usuario("user-6", null)]);
    await t.db.insert(matches).values([cruce("o1", "octavos", 2, 1), cruce("o2", "octavos", 1, 1), cruce("c1", "cuartos", 0, 3)]);
    // Solo puntúa lo vinculado en prode_matches (la fase sale de ahí)
    await t.db.insert(prodeMatches).values([["o1", "octavos"], ["o2", "octavos"], ["c1", "cuartos"]].map(([matchId, fase]) => ({ matchId, fase, createdAt: AYER })));
    await t.db.insert(prodePredictions).values([
      // Ana: 3 + 1 + 3 = 7 (2 exactos, 3 aciertos)
      pronostico("user-1", "o1", 2, 1), pronostico("user-1", "o2", 0, 0), pronostico("user-1", "c1", 0, 3),
      // Zoe: 3 + 0 + 0 = 3 (1 exacto, 1 acierto)
      pronostico("user-3", "o1", 2, 1), pronostico("user-3", "o2", 1, 0), pronostico("user-3", "c1", 1, 0),
      // beto y Álvaro: 1 + 1 + 1 = 3 (0 exactos, 3 aciertos): empatan en todo menos el nombre
      pronostico("user-4", "o1", 1, 0), pronostico("user-4", "o2", 2, 2), pronostico("user-4", "c1", 0, 1),
      pronostico("user-5", "o1", 1, 0), pronostico("user-5", "o2", 2, 2), pronostico("user-5", "c1", 0, 1),
      // Luis: 0
      pronostico("user-2", "o1", 0, 1),
    ]);
  });

  async function crearGrupo() {
    await t.db.insert(prodeGroups).values({ id: "g1", name: "Amigos", inviteCode: "ABC123", ownerId: "user-1", createdAt: AHORA.getTime() });
    await t.db.insert(prodeGroupMembers).values(
      ["user-1", "user-2", "user-6"].map((userId) => ({ groupId: "g1", userId, joinedAt: AHORA.getTime() }))
    );
  }

  describe("rankingProde", () => {
    it("ordena por puntos, desempata por exactos y por nombre, y comparte la posición si empatan los números", async () => {
      const filas = await rankingProde(t.db, {});
      expect(resumen(filas)).toEqual([
        [1, "Ana", 7],
        [2, "Zoe", 3], // 1 exacto le gana a beto y Álvaro (mismos puntos, 0 exactos)
        [3, "Álvaro", 3], // mismo puntaje, exactos y aciertos: orden alfabético sin tildes, posición compartida
        [3, "beto", 3],
        [5, "Luis", 0], // competición estándar: 1, 2, 3, 3, 5
      ]);
      expect(filas[0]).toEqual({ posicion: 1, nombre: "Ana", puntos: 7, exactos: 2, aciertos: 3, esVos: false });
      expect(filas[2]).toMatchObject({ exactos: 0, aciertos: 3 });
    });

    it("marca la fila propia con esVos", async () => {
      const filas = await rankingProde(t.db, { vos: "user-3" });
      expect(filas.filter((f) => f.esVos).map((f) => f.nombre)).toEqual(["Zoe"]);
    });

    it("filtra por fase", async () => {
      expect(resumen(await rankingProde(t.db, { fase: "cuartos" }))).toEqual([
        [1, "Ana", 3],
        [2, "Álvaro", 1],
        [2, "beto", 1],
        [4, "Zoe", 0],
      ]);
    });

    it("una corrección de resultado reordena la tabla", async () => {
      await t.DB.prepare("UPDATE matches SET home_score = 1, away_score = 0 WHERE id = 'c1'").run();
      const filas = await rankingProde(t.db, {});
      expect(filas[0]).toMatchObject({ posicion: 1, nombre: "Zoe", puntos: 6, exactos: 2 });
      expect(filas[1]).toMatchObject({ posicion: 2, nombre: "Ana", puntos: 4 });
    });

    it("grupo: solo integrantes, y quien no pronosticó figura en 0 con el nombre genérico", async () => {
      await crearGrupo();
      expect(resumen(await rankingProde(t.db, { grupoId: "g1" }))).toEqual([
        [1, "Ana", 7],
        [2, "Luis", 0],
        [2, "Participante", 0],
      ]);
      expect(resumen(await rankingProde(t.db, { grupoId: "g1", fase: "cuartos" }))).toEqual([
        [1, "Ana", 3],
        [2, "Luis", 0],
        [2, "Participante", 0],
      ]);
    });
  });

  describe("GET /api/prode/ranking", () => {
    it("sin sesión responde 401", async () => {
      expect((await callApi(GET_GENERAL, t.DB, { path: "/api/prode/ranking" })).status).toBe(401);
    });

    it("devuelve el ranking general sin emails ni ids de usuario", async () => {
      const res = await callApi(GET_GENERAL, t.DB, { user: fixtures.other, path: "/api/prode/ranking" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.fase).toBeNull();
      expect(body.total).toBe(5);
      expect(resumen(body.filas)).toEqual([[1, "Ana", 7], [2, "Zoe", 3], [3, "Álvaro", 3], [3, "beto", 3], [5, "Luis", 0]]);
      expect(body.yo).toEqual({ posicion: 5, nombre: "Luis", puntos: 0, exactos: 0, aciertos: 0, esVos: true });
      const texto = JSON.stringify(body);
      for (const dato of ["user-", "@example.test", "Nombre "]) expect(texto).not.toContain(dato);
    });

    it("filtra por fase y rechaza una fase inválida", async () => {
      const ok = (await (await callApi(GET_GENERAL, t.DB, { user: fixtures.user, path: "/api/prode/ranking?fase=cuartos" })).json()) as any;
      expect(ok.fase).toBe("cuartos");
      expect(resumen(ok.filas)).toEqual([[1, "Ana", 3], [2, "Álvaro", 1], [2, "beto", 1], [4, "Zoe", 0]]);
      const mal = await callApi(GET_GENERAL, t.DB, { user: fixtures.user, path: "/api/prode/ranking?fase=grupos" });
      expect(mal.status).toBe(400);
      expect(await mal.json()).toEqual({ error: "fase_invalida" });
    });

    it("devuelve 100 filas como máximo y la propia aparte si queda fuera", async () => {
      const extra = Array.from({ length: 100 }, (_, i) => usuario(`extra-${String(i).padStart(3, "0")}`, `Extra ${i}`));
      for (let i = 0; i < extra.length; i += 10) {
        await t.db.insert(users).values(extra.slice(i, i + 10));
        await t.db.insert(prodePredictions).values(extra.slice(i, i + 10).map((u) => pronostico(u.id, "o2", 1, 1)));
      }
      const body = (await (await callApi(GET_GENERAL, t.DB, { user: fixtures.other, path: "/api/prode/ranking" })).json()) as any;
      expect(body.filas).toHaveLength(100);
      expect(body.total).toBe(105);
      expect(body.filas.some((f: any) => f.esVos)).toBe(false);
      expect(body.yo).toMatchObject({ posicion: 105, nombre: "Luis", esVos: true });
    });

    it("quien no tiene puntos confirmados no figura y recibe yo: null", async () => {
      const sinPuntos = (await t.db.select().from(users).where(eq(users.id, "user-6")))[0] as User;
      const body = (await (await callApi(GET_GENERAL, t.DB, { user: sinPuntos, path: "/api/prode/ranking" })).json()) as any;
      expect(body.yo).toBeNull();
    });
  });

  describe("GET /api/prode/grupos/[id]/ranking", () => {
    beforeEach(crearGrupo);

    it("sin sesión responde 401", async () => {
      expect((await callApi(GET_GRUPO, t.DB, { params: { id: "g1" } })).status).toBe(401);
    });

    it("un integrante ve el ranking acumulado y por fase del grupo", async () => {
      const res = await callApi(GET_GRUPO, t.DB, { user: fixtures.other, params: { id: "g1" }, path: "/api/prode/grupos/g1/ranking" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(body.fase).toBeNull();
      expect(resumen(body.filas)).toEqual([[1, "Ana", 7], [2, "Luis", 0], [2, "Participante", 0]]);
      expect(body.yo).toMatchObject({ posicion: 2, nombre: "Luis", esVos: true });
      expect(JSON.stringify(body)).not.toMatch(/user-|@example\.test/);

      const fase = (await (await callApi(GET_GRUPO, t.DB, { user: fixtures.other, params: { id: "g1" }, path: "/api/prode/grupos/g1/ranking?fase=octavos" })).json()) as any;
      expect(resumen(fase.filas)).toEqual([[1, "Ana", 4], [2, "Luis", 0], [2, "Participante", 0]]);
    });

    it("un no integrante o un grupo inexistente reciben el mismo 404", async () => {
      const zoe = (await t.db.select().from(users).where(eq(users.id, "user-3")))[0] as User;
      const ajeno = await callApi(GET_GRUPO, t.DB, { user: zoe, params: { id: "g1" } });
      const inexistente = await callApi(GET_GRUPO, t.DB, { user: zoe, params: { id: "nada" } });
      expect(ajeno.status).toBe(404);
      expect(inexistente.status).toBe(404);
      expect(await ajeno.json()).toEqual(await inexistente.json());
    });

    it("rechaza una fase inválida", async () => {
      const res = await callApi(GET_GRUPO, t.DB, { user: fixtures.user, params: { id: "g1" }, path: "/api/prode/grupos/g1/ranking?fase=x" });
      expect(res.status).toBe(400);
    });
  });
});
