import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";

const DIR = join(process.cwd(), "drizzle", "migrations");

async function aplicar(DB: D1Database, archivo: string) {
  const sql = readFileSync(join(DIR, archivo), "utf8")
    .split(/\r?\n/)
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n");
  for (const sentencia of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    await DB.prepare(sentencia).run();
  }
}

// Base en el estado previo a 0006, con duplicados sembrados, para probar la deduplicación
describe("migración 0006 (calendar_syncs idempotente)", () => {
  let mf: Miniflare;
  let DB: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "fisture-mig" },
    });
    DB = (await mf.getD1Database("DB")) as unknown as D1Database;
    for (const f of [
      "0000_init.sql",
      "0001_add_multi_source_support.sql",
      "0002_preferences_and_sync_state.sql",
      "0003_league_teams.sql",
      "0004_sync_runs.sql",
      "0005_calendar_syncs_user_match_idx.sql",
    ]) {
      await aplicar(DB, f);
    }

    await DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES ('u1','a@a','A','google','g1')").run();
    await DB.prepare("INSERT INTO leagues (id, name, country, external_id, season, is_active) VALUES ('l1','L','AR','e',2026,1)").run();
    for (const id of ["t1", "t2"]) {
      await DB.prepare("INSERT INTO teams (id, external_id, name, league_id) VALUES (?, ?, ?, 'l1')").bind(id, `e-${id}`, id).run();
    }
    for (const [id, venue] of [["m1", "Bombonera"], ["m2", ""], ["m3", "Monumental"]]) {
      await DB.prepare(
        "INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status, venue) VALUES (?, ?, 't1','t2','l1', 1800000000, 'scheduled', ?)"
      ).bind(id, `e-${id}`, venue).run();
    }
    const fila = (id: string, match: string, status: string, ev: string | null, last: number | null) =>
      DB.prepare(
        "INSERT INTO calendar_syncs (id, user_id, match_id, provider, status, external_event_id, last_synced_at) VALUES (?, 'u1', ?, 'google', ?, ?, ?)"
      ).bind(id, match, status, ev, last).run();
    // m1: duplicado; debe quedar la synced con evento
    await fila("d1a", "m1", "failed", null, 100);
    await fila("d1b", "m1", "synced", "ev1", 50);
    // m2: sola, synced, sede vacía
    await fila("d2", "m2", "synced", "ev2", 10);
    // m3: sola, pending
    await fila("d3", "m3", "pending", null, null);

    await aplicar(DB, "0006_calendar_syncs_idempotencia.sql");
  });
  afterAll(async () => {
    await mf.dispose();
  });

  it("deja una sola fila por (usuario, partido), la synced con evento", async () => {
    const { results } = await DB.prepare("SELECT id FROM calendar_syncs WHERE match_id = 'm1'").all<{ id: string }>();
    expect(results.map((r) => r.id)).toEqual(["d1b"]);
  });

  it("el índice único rechaza un duplicado nuevo", async () => {
    await expect(
      DB.prepare("INSERT INTO calendar_syncs (id, user_id, match_id, provider) VALUES ('x', 'u1', 'm3', 'google')").run()
    ).rejects.toThrow();
  });

  it("completa synced_state y synced_venue solo en las filas synced", async () => {
    const q = (id: string) =>
      DB.prepare("SELECT synced_state AS s, synced_venue AS v FROM calendar_syncs WHERE id = ?").bind(id).first<{ s: string | null; v: string | null }>();
    expect(await q("d1b")).toEqual({ s: "scheduled", v: "Bombonera" });
    expect(await q("d2")).toEqual({ s: "scheduled", v: null }); // sede '' normalizada a NULL
    expect(await q("d3")).toEqual({ s: null, v: null });
  });
});
