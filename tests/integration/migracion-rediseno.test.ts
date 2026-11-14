// Migración 0015 (docs/31 §4): columnas del rediseño sobre una base con datos existentes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";

const DIR = join(process.cwd(), "drizzle", "migrations");
const NUEVA = "0015_rediseno_onboarding.sql";

async function aplicar(DB: D1Database, archivo: string) {
  const sql = readFileSync(join(DIR, archivo), "utf8")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const sentencia of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await DB.prepare(sentencia).run();
  }
}

describe("migración 0015 (rediseño y onboarding)", () => {
  let mf: Miniflare;
  let DB: D1Database;

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "fisture-mig-0015" } });
    DB = (await mf.getD1Database("DB")) as unknown as D1Database;
    for (const f of readdirSync(DIR).filter((f) => f.endsWith(".sql") && f < NUEVA).sort()) await aplicar(DB, f);
  });
  afterEach(() => mf.dispose());

  const filas = async (sql: string) => (await DB.prepare(sql).all<any>()).results;

  it("los usuarios existentes quedan con el onboarding hecho, en su fecha de alta", async () => {
    await DB.prepare("INSERT INTO users (id, email, name, provider, provider_id, created_at) VALUES ('u1', 'a@x.test', 'A', 'google', 'g-1', 1790000000)").run();
    await aplicar(DB, NUEVA);
    expect(await filas("SELECT id, onboarded_at FROM users")).toEqual([{ id: "u1", onboarded_at: 1790000000 }]);
  });

  it("un usuario nuevo después de la migración arranca sin onboarding", async () => {
    await aplicar(DB, NUEVA);
    await DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES ('u2', 'b@x.test', 'B', 'google', 'g-2')").run();
    expect(await filas("SELECT onboarded_at FROM users")).toEqual([{ onboarded_at: null }]);
  });

  it("las preferencias existentes quedan con auto-sync por defecto activado", async () => {
    await DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES ('u1', 'a@x.test', 'A', 'google', 'g-1')").run();
    await DB.prepare("INSERT INTO user_preferences (user_id, reminder_60, reminder_15, theme) VALUES ('u1', 1, 0, 'nocturna')").run();
    await aplicar(DB, NUEVA);
    expect(await filas("SELECT auto_sync_default FROM user_preferences")).toEqual([{ auto_sync_default: 1 }]);
  });

  it("los eventos existentes no tienen hora anterior", async () => {
    await aplicar(DB, NUEVA);
    const columnas = (await filas("PRAGMA table_info(calendar_syncs)")).map((c) => c.name);
    expect(columnas).toEqual(expect.arrayContaining(["previous_date_time", "date_time_changed_at"]));
  });
});
