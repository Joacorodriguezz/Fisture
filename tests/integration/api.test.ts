import { beforeEach, describe, expect, it } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { relojFijo } from "../helpers/clock";
import { seedApp } from "../helpers/fixtures";
import { callApi } from "../helpers/api";
import { createDb } from "../../src/lib/db";
import { GET as listTeams, POST as follow } from "../../src/pages/api/equipos/index";
import { DELETE as unfollow, PATCH as autoSync } from "../../src/pages/api/equipos/[id]";
import { GET as search } from "../../src/pages/api/equipos/buscar";
import { GET as getPrefs, PATCH as patchPrefs } from "../../src/pages/api/preferencias";
import { GET as download } from "../../src/pages/api/calendario/download";
import { userPreferences, userTeams } from "../../drizzle/schema";

describe("API con D1 real efímera", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  relojFijo();
  beforeEach(async () => {
    fixtures = await seedApp(t.db);
  });

  const call = (handler: Parameters<typeof callApi>[0], options: Parameters<typeof callApi>[2] = {}) => callApi(handler, t.DB, options);
  const seguir = (teamId: string, user = fixtures.user) => call(follow, { user, method: "POST", body: { teamId } });
  const patchPreferencias = (body: unknown, user = fixtures.user) => call(patchPrefs, { user, method: "PATCH", body });
  const preferencias = async (user = fixtures.user) => (await call(getPrefs, { user })).json();

  describe("autenticación", () => {
    it.each([
      ["GET /equipos", listTeams],
      ["POST /equipos", follow],
      ["DELETE /equipos/[id]", unfollow],
      ["PATCH /equipos/[id]", autoSync],
      ["GET /preferencias", getPrefs],
      ["PATCH /preferencias", patchPrefs],
      ["GET /calendario/download", download],
    ])("%s rechaza usuarios sin sesión", async (_nombre, handler) => {
      expect((await call(handler)).status).toBe(401);
    });
  });

  describe("equipos", () => {
    it("seguir un equipo responde 201 y aparece en la lista del usuario con auto-sync activado", async () => {
      expect((await seguir("river")).status).toBe(201);
      expect(await (await call(listTeams, { user: fixtures.user })).json()).toEqual([expect.objectContaining({ teamId: "river", autoSync: true })]);
    });

    it("seguir dos veces el mismo equipo responde 409", async () => {
      await seguir("river");
      expect((await seguir("river")).status).toBe(409);
    });

    it("la lista de un usuario no expone los equipos de otro", async () => {
      await seguir("river");
      expect(await (await call(listTeams, { user: fixtures.other })).json()).toEqual([]);
    });

    it("otro usuario no puede dejar de seguir un equipo ajeno", async () => {
      await seguir("river");
      expect((await call(unfollow, { user: fixtures.other, params: { id: "river" } })).status).toBe(404);
      expect(await createDb(t.DB).select().from(userTeams)).toHaveLength(1);
    });

    it("dejar de seguir elimina el equipo de la lista", async () => {
      await seguir("river");
      expect((await call(unfollow, { user: fixtures.user, params: { id: "river" } })).status).toBe(200);
      expect(await (await call(listTeams, { user: fixtures.user })).json()).toEqual([]);
    });

    it("desactivar el auto-sync se refleja en la lista", async () => {
      await seguir("river");
      const res = await call(autoSync, { user: fixtures.user, method: "PATCH", params: { id: "river" }, body: { autoSync: false } });
      expect(res.status).toBe(200);
      expect(await (await call(listTeams, { user: fixtures.user })).json()).toEqual([expect.objectContaining({ autoSync: false })]);
    });

    it("seguir un equipo inexistente responde 404", async () => {
      expect((await seguir("missing")).status).toBe(404);
    });

    it.each([
      ["objeto vacío", {}],
      ["null", null],
      ["arreglo", []],
      ["teamId numérico", { teamId: 123 }],
    ])("seguir con cuerpo inválido (%s) responde 400", async (_caso, body) => {
      expect((await call(follow, { user: fixtures.user, method: "POST", body })).status).toBe(400);
    });

    it("auto-sync que no es booleano responde 400", async () => {
      await seguir("river");
      const res = await call(autoSync, { user: fixtures.user, method: "PATCH", params: { id: "river" }, body: { autoSync: "yes" } });
      expect(res.status).toBe(400);
    });
  });

  describe("búsqueda de equipos", () => {
    const buscar = async (q: string, user = fixtures.user) => (await call(search, { user, path: `/api/equipos/buscar?q=${q}` })).json();

    it("una consulta de menos de 2 caracteres devuelve una lista vacía", async () => {
      expect(await buscar("r")).toEqual([]);
    });

    it("marca isFollowing=false en un equipo que no se sigue", async () => {
      expect(await buscar("River")).toEqual([expect.objectContaining({ id: "river", isFollowing: false })]);
    });

    it("marca isFollowing=true en un equipo que se sigue", async () => {
      await seguir("river");
      expect(await buscar("River")).toEqual([expect.objectContaining({ id: "river", isFollowing: true })]);
    });
  });

  describe("preferencias", () => {
    it("sin cambios devuelve los valores por defecto", async () => {
      expect(await preferencias()).toEqual({ reminder60: true, reminder15: true, theme: "papel" });
    });

    it("los cambios parciales se acumulan", async () => {
      await patchPreferencias({ theme: "nocturna" });
      await patchPreferencias({ reminder60: false });
      expect(await preferencias()).toEqual({ reminder60: false, reminder15: true, theme: "nocturna" });
    });

    it("las preferencias de un usuario no afectan a otro", async () => {
      await patchPreferencias({ theme: "nocturna" });
      expect(await preferencias(fixtures.other)).toEqual({ reminder60: true, reminder15: true, theme: "papel" });
    });

    it("guarda una sola fila por usuario aunque se modifique varias veces", async () => {
      await patchPreferencias({ theme: "nocturna" });
      await patchPreferencias({ reminder60: false });
      expect(await createDb(t.DB).select().from(userPreferences)).toHaveLength(1);
    });

    it.each([
      ["objeto vacío", {}],
      ["tema inválido", { theme: "invalid" }],
      ["booleano como string", { reminder60: "true" }],
    ])("un cuerpo inválido (%s) responde 400", async (_caso, body) => {
      expect((await patchPreferencias(body)).status).toBe(400);
    });
  });

  describe("descarga de calendario (ICS)", () => {
    const descargar = (query: string, user = fixtures.user) => call(download, { user, path: `/api/calendario/download?${query}` });

    it("sin parámetros responde 400", async () => {
      expect((await call(download, { user: fixtures.user })).status).toBe(400);
    });

    it("un partido inexistente responde 404", async () => {
      expect((await descargar("matchId=missing")).status).toBe(404);
    });

    it("all=true sin equipos seguidos responde 404", async () => {
      expect((await descargar("all=true")).status).toBe(404);
    });

    it.each(["all=true", "matchId=superclasico", "teamId=river"])("%s devuelve un ICS con un solo evento", async (query) => {
      await createDb(t.DB).insert(userTeams).values({ userId: fixtures.user.id, teamId: "river" });
      const response = await descargar(query);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/calendar");
      expect(response.headers.get("content-disposition")).toContain(".ics");
      expect(text).toContain("SUMMARY:River Plate vs Boca Juniors");
      expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    });

    it("usa los recordatorios guardados en las preferencias", async () => {
      await createDb(t.DB).insert(userTeams).values({ userId: fixtures.user.id, teamId: "river" });
      await patchPreferencias({ reminder60: false });
      const text = await (await descargar("all=true")).text();
      expect(text).toContain("TRIGGER:-PT15M");
      expect(text).not.toContain("TRIGGER:-PT60M");
    });

    it("all=true no incluye los equipos de otro usuario", async () => {
      await createDb(t.DB).insert(userTeams).values({ userId: fixtures.user.id, teamId: "river" });
      expect((await descargar("all=true", fixtures.other)).status).toBe(404);
    });
  });
});
