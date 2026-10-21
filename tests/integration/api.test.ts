import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/d1";
import { createDb } from "../../src/lib/db";
import { seedApp } from "../helpers/fixtures";
import { callApi } from "../helpers/api";
import { GET as listTeams, POST as follow } from "../../src/pages/api/equipos/index";
import { DELETE as unfollow, PATCH as autoSync } from "../../src/pages/api/equipos/[id]";
import { GET as search } from "../../src/pages/api/equipos/buscar";
import { GET as getPrefs, PATCH as patchPrefs } from "../../src/pages/api/preferencias";
import { GET as download } from "../../src/pages/api/calendario/download";
import { userPreferences, userTeams } from "../../drizzle/schema";

describe("API con D1 real efímera", () => {
  let t: TestDb;
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  beforeEach(async () => { t = await createTestDb(); fixtures = await seedApp(createDb(t.DB)); });
  afterEach(async () => { await t?.dispose(); });

  it("todos los handlers protegidos rechazan usuarios sin sesión", async () => {
    for (const handler of [listTeams, follow, unfollow, autoSync, getPrefs, patchPrefs, search, download]) {
      expect((await callApi(handler, t.DB)).status).toBe(401);
    }
  });
  it("sigue, lista y elimina equipos sin exponer los de otro usuario", async () => {
    const { user, other } = fixtures;
    expect((await callApi(follow, t.DB, { user, method: "POST", body: { teamId: "river" } })).status).toBe(201);
    expect((await callApi(follow, t.DB, { user, method: "POST", body: { teamId: "river" } })).status).toBe(409);
    expect(await (await callApi(listTeams, t.DB, { user: other })).json()).toEqual([]);
    const own = await (await callApi(listTeams, t.DB, { user })).json();
    expect(own).toEqual([expect.objectContaining({ teamId: "river", autoSync: true })]);
    expect((await callApi(unfollow, t.DB, { user: other, params: { id: "river" } })).status).toBe(404);
    expect((await callApi(autoSync, t.DB, { user, method: "PATCH", params: { id: "river" }, body: { autoSync: false } })).status).toBe(200);
    expect((await callApi(unfollow, t.DB, { user, params: { id: "river" } })).status).toBe(200);
    expect(await (await callApi(listTeams, t.DB, { user })).json()).toEqual([]);
  });
  it("valida seguimiento y búsqueda, incluyendo estado de favorito", async () => {
    const { user } = fixtures;
    expect((await callApi(follow, t.DB, { user, method: "POST", body: {} })).status).toBe(400);
    for (const body of [null, [], { teamId: 123 }]) {
      expect((await callApi(follow, t.DB, { user, method: "POST", body })).status).toBe(400);
    }
    expect((await callApi(autoSync, t.DB, { user, method: "PATCH", params: { id: "river" }, body: { autoSync: "yes" } })).status).toBe(400);
    expect((await callApi(follow, t.DB, { user, method: "POST", body: { teamId: "missing" } })).status).toBe(404);
    expect(await (await callApi(search, t.DB, { user, path: "/api/equipos/buscar?q=r" })).json()).toEqual([]);
    await callApi(follow, t.DB, { user, method: "POST", body: { teamId: "river" } });
    const result = await (await callApi(search, t.DB, { user, path: "/api/equipos/buscar?q=River" })).json();
    expect(result).toEqual([expect.objectContaining({ id: "river", isFollowing: true })]);
  });
  it("persiste preferencias parciales y mantiene aislamiento entre usuarios", async () => {
    const { user, other } = fixtures;
    expect(await (await callApi(getPrefs, t.DB, { user })).json()).toEqual({ reminder60: true, reminder15: true, theme: "papel" });
    for (const body of [{ theme: "nocturna" }, { reminder60: false }]) {
      expect((await callApi(patchPrefs, t.DB, { user, method: "PATCH", body })).status).toBe(200);
    }
    expect(await (await callApi(getPrefs, t.DB, { user })).json()).toEqual({ reminder60: false, reminder15: true, theme: "nocturna" });
    expect(await (await callApi(getPrefs, t.DB, { user: other })).json()).toEqual({ reminder60: true, reminder15: true, theme: "papel" });
    for (const body of [{}, { theme: "invalid" }, { reminder60: "true" }]) {
      expect((await callApi(patchPrefs, t.DB, { user, method: "PATCH", body })).status).toBe(400);
    }
    expect(await createDb(t.DB).select().from(userPreferences)).toHaveLength(1);
  });
  it("descarga ICS con preferencias reales, errores y favoritos de cada usuario", async () => {
    const { user, other } = fixtures;
    expect((await callApi(download, t.DB, { user })).status).toBe(400);
    expect((await callApi(download, t.DB, { user, path: "/api/calendario/download?matchId=missing" })).status).toBe(404);
    expect((await callApi(download, t.DB, { user, path: "/api/calendario/download?all=true" })).status).toBe(404);
    await createDb(t.DB).insert(userTeams).values({ userId: user.id, teamId: "river" });
    await callApi(patchPrefs, t.DB, { user, method: "PATCH", body: { reminder60: false } });
    for (const query of ["all=true", "matchId=superclasico", "teamId=river"]) {
      const response = await callApi(download, t.DB, { user, path: `/api/calendario/download?${query}` });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/calendar");
      expect(response.headers.get("content-disposition")).toContain(".ics");
      const text = await response.text();
      expect(text).toContain("SUMMARY:River Plate vs Boca Juniors");
      expect(text).toContain("TRIGGER:-PT15M");
      expect(text).not.toContain("TRIGGER:-PT60M");
      expect(text.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    }
    expect((await callApi(download, t.DB, { user: other, path: "/api/calendario/download?all=true" })).status).toBe(404);
  });
});
