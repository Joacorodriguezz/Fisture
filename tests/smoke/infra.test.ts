import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../helpers/d1";

describe("infraestructura de tests", () => {
  let t: TestDb;

  beforeAll(async () => {
    t = await createTestDb();
  });
  afterAll(async () => {
    await t.dispose();
  });

  it("aplica las migraciones sobre una D1 efímera", async () => {
    const { results } = await t.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users','leagues','teams','matches','league_teams')"
    ).all<{ name: string }>();
    expect(results.map((r) => r.name).sort()).toEqual(["league_teams", "leagues", "matches", "teams", "users"]);
  });

  it("escribe y lee en la base", async () => {
    await t.DB.prepare("INSERT INTO leagues (id, name, country, external_id, season) VALUES (?, ?, ?, ?, ?)")
      .bind("l1", "Liga de prueba", "AR", "arg.1", "2026")
      .run();
    const fila = await t.DB.prepare("SELECT name FROM leagues WHERE id = ?").bind("l1").first<{ name: string }>();
    expect(fila?.name).toBe("Liga de prueba");
  });
});
