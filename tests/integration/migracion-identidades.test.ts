// Migración 0010 (docs/18, V-18 y V-19): backfill de oauth_identities desde users sobre datos existentes.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";

const DIR = join(process.cwd(), "drizzle", "migrations");
const NUEVA = "0010_oauth_identities.sql";

async function aplicar(DB: D1Database, archivo: string) {
  const sql = readFileSync(join(DIR, archivo), "utf8")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const sentencia of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await DB.prepare(sentencia).run();
  }
}

describe("migración 0010 (identidades OAuth)", () => {
  let mf: Miniflare;
  let DB: D1Database;

  beforeEach(async () => {
    mf = new Miniflare({ modules: true, script: "export default { fetch() { return new Response('ok'); } }", d1Databases: { DB: "fisture-mig-0010" } });
    DB = (await mf.getD1Database("DB")) as unknown as D1Database;
    for (const f of readdirSync(DIR).filter((f) => f.endsWith(".sql") && f < NUEVA).sort()) await aplicar(DB, f);
  });
  afterEach(() => mf.dispose());

  const insertarUsuario = (id: string, email: string, provider: string, providerId: string, extra = "NULL, NULL, NULL") =>
    DB.prepare(`INSERT INTO users (id, email, name, provider, provider_id, access_token, refresh_token, token_expires_at) VALUES (?, ?, 'N', ?, ?, ${extra})`)
      .bind(id, email, provider, providerId)
      .run();
  const filas = async (sql: string) => (await DB.prepare(sql).all<any>()).results;

  it("V-18: cada usuario obtiene exactamente una identidad con sus tokens, sin duplicados", async () => {
    await insertarUsuario("u1", "Ana@Example.com", "google", "g-1", "'enc:v1:abc', 'enc:v1:def', 1800000000");
    await insertarUsuario("u2", "beto@corp.com", "microsoft", "m-1", "'at-2', 'rt-2', 1800000001");

    await aplicar(DB, NUEVA);

    expect(await filas("SELECT COUNT(*) AS n FROM oauth_identities")).toEqual([{ n: 2 }]);
    expect(await filas("SELECT id, user_id, provider, provider_id, email, email_verified, access_token, refresh_token, token_expires_at FROM oauth_identities ORDER BY id")).toEqual([
      { id: "u1", user_id: "u1", provider: "google", provider_id: "g-1", email: "ana@example.com", email_verified: 1, access_token: "enc:v1:abc", refresh_token: "enc:v1:def", token_expires_at: 1800000000 },
      { id: "u2", user_id: "u2", provider: "microsoft", provider_id: "m-1", email: "beto@corp.com", email_verified: 0, access_token: "at-2", refresh_token: "rt-2", token_expires_at: 1800000001 },
    ]);
    expect(await filas("SELECT provider, provider_id FROM oauth_identities GROUP BY provider, provider_id HAVING COUNT(*) > 1")).toEqual([]);
    expect(await filas("PRAGMA foreign_key_check")).toEqual([]);
  });

  it("normaliza los emails y marca como verificados solo los de Google", async () => {
    await insertarUsuario("u1", "  Ana@Example.com ", "google", "g-1");
    await insertarUsuario("u2", "Beto@Corp.com", "microsoft", "m-1");
    await aplicar(DB, NUEVA);
    expect(await filas("SELECT id, email, email_verified FROM users ORDER BY id")).toEqual([
      { id: "u1", email: "ana@example.com", email_verified: 1 },
      { id: "u2", email: "beto@corp.com", email_verified: 0 },
    ]);
  });

  it("V-19: conserva los ids de users, calendar_syncs y sesiones", async () => {
    await insertarUsuario("u1", "ana@example.com", "google", "g-1");
    await DB.prepare("INSERT INTO leagues (id, name, country, external_id, season, is_active) VALUES ('l1','L','AR','e',2026,1)").run();
    for (const id of ["t1", "t2"]) await DB.prepare("INSERT INTO teams (id, external_id, name, league_id) VALUES (?, ?, ?, 'l1')").bind(id, `e-${id}`, id).run();
    await DB.prepare("INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status) VALUES ('m1','e-m1','t1','t2','l1',1800000000,'scheduled')").run();
    await DB.prepare("INSERT INTO calendar_syncs (id, user_id, match_id, provider, status) VALUES ('s1','u1','m1','google','synced')").run();
    await DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('h1','u1',1,2)").run();

    await aplicar(DB, NUEVA);

    expect(await filas("SELECT id FROM users")).toEqual([{ id: "u1" }]);
    expect(await filas("SELECT user_id FROM calendar_syncs")).toEqual([{ user_id: "u1" }]);
    expect(await filas("SELECT id, user_id FROM sessions")).toEqual([{ id: "h1", user_id: "u1" }]);
  });

  // Ojo: el helper aplica las sentencias una por una, así que esto prueba que la migración FALLA con colisiones,
  // no que wrangler la revierta completa. En producción el pre-chequeo es obligatorio (docs/23 §6,
  // scripts/check-email-collisions.mjs) justamente para no depender de eso.
  it("aborta de forma explícita si dos usuarios difieren solo en mayúsculas", async () => {
    await insertarUsuario("u1", "ana@example.com", "google", "g-1");
    await insertarUsuario("u2", "Ana@Example.com", "microsoft", "m-1");
    await expect(aplicar(DB, NUEVA)).rejects.toThrow(/UNIQUE/i);
    // No se creó la tabla de identidades
    expect(await filas("SELECT name FROM sqlite_master WHERE name = 'oauth_identities'")).toEqual([]);
  });
});
