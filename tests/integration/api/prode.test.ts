// Endpoints del prode (docs/37 §3.4): sesión, validaciones, errores con código y caminos felices.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "../../../drizzle/schema";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, relojFijo } from "../../helpers/clock";
import { callApi } from "../../helpers/api";
import { silenciarConsola } from "../../helpers/ctx";
import { COPA, LIGA, sembrarProde } from "../../helpers/prode";
import { POST as crear } from "../../../src/pages/api/prode/grupos/index";
import { DELETE as borrar } from "../../../src/pages/api/prode/grupos/[id]/index";
import { POST as salir } from "../../../src/pages/api/prode/grupos/[id]/salir";
import { POST as codigo } from "../../../src/pages/api/prode/grupos/[id]/codigo";
import { DELETE as expulsar } from "../../../src/pages/api/prode/grupos/[id]/miembros/[userId]";
import { POST as unirse } from "../../../src/pages/api/prode/unirse";
import { PUT as pronosticar } from "../../../src/pages/api/prode/pronosticos";
import { MAX_PRONOSTICOS_POR_REQUEST } from "../../../src/lib/prode/reglas";
import { crearGrupo } from "../../../src/lib/prode/repo";

const yo = (id: string) => ({ id }) as User;

describe("API del prode", () => {
  const t = useTestDb();
  relojFijo();

  beforeEach(async () => {
    silenciarConsola(vi);
    await sembrarProde(t.DB);
  });

  async function grupoDe(userId = "ana") {
    const res = await callApi(crear, t.DB, { user: yo(userId), method: "POST", body: { nombre: "Los del Cinco", ligaId: LIGA } });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string; codigo: string };
  }

  describe("POST /api/prode/grupos", () => {
    it("sin sesión responde 401", async () => {
      const res = await callApi(crear, t.DB, { method: "POST", body: { nombre: "Los del Cinco", ligaId: LIGA } });
      expect(res.status).toBe(401);
    });

    it("crea el grupo y devuelve id y código", async () => {
      const { id, codigo } = await grupoDe();
      expect(id).toBeTruthy();
      expect(codigo).toMatch(/^[A-Z2-9]{8}$/);
    });

    it("valida nombre, competencia y cuerpo", async () => {
      const post = (body: unknown) => callApi(crear, t.DB, { user: yo("ana"), method: "POST", body });
      let res = await post({ nombre: "ab", ligaId: LIGA });
      expect([res.status, await res.json()]).toEqual([400, { error: "nombre_invalido" }]);
      res = await post({ nombre: "Copa con amigos", ligaId: COPA });
      expect([res.status, await res.json()]).toEqual([400, { error: "liga_invalida" }]);
      res = await post({ nombre: "Sin liga" });
      expect([res.status, await res.json()]).toEqual([400, { error: "liga_invalida" }]);
      res = await callApi(crear, t.DB, { user: yo("ana"), method: "POST", rawBody: "{no es json" });
      expect([res.status, await res.json()]).toEqual([400, { error: "cuerpo_invalido" }]);
    });

    it("el límite de grupos responde 409", async () => {
      for (let i = 0; i < 20; i++) await crearGrupo(t.DB, { userId: "ana", nombre: `G${i}`, ligaId: LIGA, ahora: AHORA });
      const res = await callApi(crear, t.DB, { user: yo("ana"), method: "POST", body: { nombre: "Uno más", ligaId: LIGA } });
      expect([res.status, await res.json()]).toEqual([409, { error: "limite_grupos" }]);
    });

    it("crear grupos se limita a 10 por hora por usuario (prode_crear)", async () => {
      for (let i = 0; i < 10; i++) await grupoDe();
      const res = await callApi(crear, t.DB, { user: yo("ana"), method: "POST", body: { nombre: "Once", ligaId: LIGA } });
      expect([res.status, (await res.json()).error]).toEqual([429, "rate_limited"]);
    });
  });

  describe("POST /api/prode/unirse", () => {
    it("acepta el código como lo escribe la gente y es idempotente", async () => {
      const g = await grupoDe();
      const escrito = `${g.codigo.slice(0, 4).toLowerCase()} ${g.codigo.slice(4)}`;
      let res = await callApi(unirse, t.DB, { user: yo("beto"), method: "POST", body: { codigo: escrito } });
      expect([res.status, await res.json()]).toEqual([200, { grupoId: g.id, yaEraMiembro: false }]);
      res = await callApi(unirse, t.DB, { user: yo("beto"), method: "POST", body: { codigo: g.codigo } });
      expect(await res.json()).toEqual({ grupoId: g.id, yaEraMiembro: true });
    });

    it("distingue un código mal escrito de uno que no existe", async () => {
      let res = await callApi(unirse, t.DB, { user: yo("beto"), method: "POST", body: { codigo: "123" } });
      expect([res.status, await res.json()]).toEqual([400, { error: "codigo_invalido" }]);
      res = await callApi(unirse, t.DB, { user: yo("beto"), method: "POST", body: { codigo: "ZZZZZZZZ" } });
      expect([res.status, await res.json()]).toEqual([404, { error: "codigo_inexistente" }]);
    });

    it("un grupo lleno responde 409", async () => {
      const g = await grupoDe();
      await t.DB.batch(
        Array.from({ length: 49 }, (_, i) => [
          t.DB.prepare("INSERT INTO users (id, email, provider, provider_id) VALUES (?1, ?2, 'google', ?1)").bind(`r${i}`, `r${i}@example.test`),
          t.DB.prepare("INSERT INTO prode_members (group_id, user_id, joined_at) VALUES (?1, ?2, 1)").bind(g.id, `r${i}`),
        ]).flat()
      );
      const res = await callApi(unirse, t.DB, { user: yo("beto"), method: "POST", body: { codigo: g.codigo } });
      expect([res.status, await res.json()]).toEqual([409, { error: "grupo_lleno" }]);
    });

    it("sin sesión responde 401", async () => {
      const res = await callApi(unirse, t.DB, { method: "POST", body: { codigo: "ZZZZZZZZ" } });
      expect(res.status).toBe(401);
    });
  });

  describe("PUT /api/prode/pronosticos", () => {
    const put = (body: unknown, user = "ana") => callApi(pronosticar, t.DB, { user: yo(user), method: "PUT", body });

    it("guarda, borra y explica cada rechazo", async () => {
      const res = await put({
        pronosticos: [
          { partidoId: "abierto-1", local: 2, visitante: 0 },
          { partidoId: "abierto-2", local: null, visitante: null },
          { partidoId: "terminado-1", local: 1, visitante: 1 },
          { partidoId: "abierto-lejos", local: 1 },
          { partidoId: "abierto-lejos", local: -1, visitante: 2 },
          { partidoId: "no-existe", local: 0, visitante: 0 },
        ],
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        guardados: [{ partidoId: "abierto-1", local: 2, visitante: 0 }],
        borrados: ["abierto-2"],
        rechazados: [
          { partidoId: "abierto-lejos", motivo: "invalido" },
          { partidoId: "terminado-1", motivo: "cerrado" },
          { partidoId: "no-existe", motivo: "inexistente" },
        ],
      });
    });

    it("rechaza cuerpos que no son una lista de pronósticos o que superan el tope", async () => {
      for (const body of [{}, { pronosticos: "x" }, { pronosticos: [{ local: 1, visitante: 1 }] }, { pronosticos: [null] }]) {
        const res = await put(body);
        expect([res.status, await res.json()]).toEqual([400, { error: "cuerpo_invalido" }]);
      }
      const muchos = Array.from({ length: MAX_PRONOSTICOS_POR_REQUEST + 1 }, (_, i) => ({ partidoId: `p${i}`, local: 0, visitante: 0 }));
      const res = await put({ pronosticos: muchos });
      expect([res.status, await res.json()]).toEqual([400, { error: "demasiados_pronosticos", maximo: MAX_PRONOSTICOS_POR_REQUEST }]);
    });

    it("sin sesión responde 401", async () => {
      const res = await callApi(pronosticar, t.DB, { method: "PUT", body: { pronosticos: [] } });
      expect(res.status).toBe(401);
    });
  });

  describe("administración", () => {
    async function conBeto() {
      const g = await grupoDe();
      await callApi(unirse, t.DB, { user: yo("beto"), method: "POST", body: { codigo: g.codigo } });
      return g;
    }

    it("regenerar el código: 403 para un miembro, 200 para el admin, 404 para un ajeno", async () => {
      const g = await conBeto();
      const post = (user: string) => callApi(codigo, t.DB, { user: yo(user), method: "POST", params: { id: g.id } });
      expect((await post("beto")).status).toBe(403);
      expect((await post("caro")).status).toBe(404);
      const res = await post("ana");
      expect(res.status).toBe(200);
      expect((await res.json()).codigo).not.toBe(g.codigo);
    });

    it("sacar a un miembro: 400 a uno mismo, 403 sin ser admin, 404 si no está, 204 si sale", async () => {
      const g = await conBeto();
      const del = (user: string, userId: string) => callApi(expulsar, t.DB, { user: yo(user), method: "DELETE", params: { id: g.id, userId } });
      expect([(await del("ana", "ana")).status, (await del("beto", "ana")).status, (await del("ana", "caro")).status]).toEqual([400, 403, 404]);
      expect((await del("ana", "beto")).status).toBe(204);
    });

    it("salir: 404 si no es miembro; el último borra el grupo", async () => {
      const g = await conBeto();
      const post = (user: string) => callApi(salir, t.DB, { user: yo(user), method: "POST", params: { id: g.id } });
      expect((await post("caro")).status).toBe(404);
      expect(await (await post("ana")).json()).toEqual({ grupoBorrado: false });
      expect(await (await post("beto")).json()).toEqual({ grupoBorrado: true });
    });

    it("borrar el grupo: 403 sin ser admin, 204 para el admin, 404 después", async () => {
      const g = await conBeto();
      const del = (user: string) => callApi(borrar, t.DB, { user: yo(user), method: "DELETE", params: { id: g.id } });
      expect((await del("beto")).status).toBe(403);
      expect((await del("ana")).status).toBe(204);
      expect((await del("ana")).status).toBe(404);
    });

    it("sin sesión todo responde 401", async () => {
      const params = { id: "x", userId: "y" };
      for (const [h, method] of [[codigo, "POST"], [salir, "POST"], [borrar, "DELETE"], [expulsar, "DELETE"]] as const) {
        expect((await callApi(h, t.DB, { method, params })).status).toBe(401);
      }
    });
  });

  it("el reloj del servidor es el que cierra: un partido que empezó no se guarda", async () => {
    vi.setSystemTime(new Date(AHORA.getTime() + 3 * 3_600_000));
    const res = await callApi(pronosticar, t.DB, { user: yo("ana"), method: "PUT", body: { pronosticos: [{ partidoId: "abierto-1", local: 1, visitante: 0 }] } });
    expect((await res.json()).rechazados).toEqual([{ partidoId: "abierto-1", motivo: "cerrado" }]);
  });
});
