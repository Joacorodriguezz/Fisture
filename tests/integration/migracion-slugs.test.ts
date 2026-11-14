// Migración 0016 (docs/33 D9): slug nullable con índice único en teams y leagues, sobre una base con datos.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";

const DIR = join(process.cwd(), "drizzle", "migrations");
const NUEVA = "0016_slugs_equipos_ligas.sql";

async function aplicar(DB: D1Database, archivo: string) {
  const sql = readFileSync(join(DIR, archivo), "utf8")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const sentencia of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await DB.prepare(sentencia).run();
  }
}

describe("migración 0016 (slugs de equipos y ligas)", () => {
  let mf: Miniflare;
  let DB: D1Database;

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "fisture-mig-0016" } });
    DB = (await mf.getD1Database("DB")) as unknown as D1Database;
    for (const f of readdirSync(DIR).filter((f) => f.endsWith(".sql") && f < NUEVA).sort()) await aplicar(DB, f);
    await DB.prepare("INSERT INTO leagues (id, external_id, name, country, season, source) VALUES ('l1', 'x:l1', 'Liga', 'Argentina', 2026, 'espn')").run();
    await DB.prepare("INSERT INTO teams (id, external_id, name, league_id, source) VALUES ('t1', 'x:t1', 'River Plate', 'l1', 'espn'), ('t2', 'x:t2', 'Boca Juniors', 'l1', 'espn')").run();
  });
  afterEach(() => mf.dispose());

  const filas = async (sql: string) => (await DB.prepare(sql).all<any>()).results;

  it("las filas existentes quedan sin slug (no hay backfill en SQL)", async () => {
    await aplicar(DB, NUEVA);
    expect(await filas("SELECT id, slug FROM teams ORDER BY id")).toEqual([{ id: "t1", slug: null }, { id: "t2", slug: null }]);
    expect(await filas("SELECT id, slug FROM leagues")).toEqual([{ id: "l1", slug: null }]);
  });

  it("el índice único admite varios NULL pero no dos slugs iguales", async () => {
    await aplicar(DB, NUEVA);
    await DB.prepare("UPDATE teams SET slug = 'river-plate' WHERE id = 't1'").run();
    await expect(DB.prepare("UPDATE teams SET slug = 'river-plate' WHERE id = 't2'").run()).rejects.toThrow(/UNIQUE/);
    await DB.prepare("UPDATE leagues SET slug = 'liga' WHERE id = 'l1'").run();
    await expect(
      DB.prepare("INSERT INTO leagues (id, external_id, name, country, season, source, slug) VALUES ('l2', 'x:l2', 'Liga', 'Chile', 2026, 'espn', 'liga')").run()
    ).rejects.toThrow(/UNIQUE/);
  });

  it("buscar por slug o por id usa los dos índices", async () => {
    await aplicar(DB, NUEVA);
    const plan = (await filas("EXPLAIN QUERY PLAN SELECT * FROM teams WHERE slug = 'river' OR id = 'river'")).map((f) => f.detail).join("\n");
    expect(plan).toMatch(/teams_slug_idx/);
    expect(plan).not.toMatch(/SCAN teams/);
  });
});
