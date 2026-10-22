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

describe("migración 0007 (reconciliar eventos de Outlook)", () => {
  let mf: Miniflare;
  let DB: D1Database;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } }",
      d1Databases: { DB: "fisture-mig-0007" },
    });
    DB = (await mf.getD1Database("DB")) as unknown as D1Database;
    for (const f of [
      "0000_init.sql",
      "0001_add_multi_source_support.sql",
      "0002_preferences_and_sync_state.sql",
      "0003_league_teams.sql",
      "0004_sync_runs.sql",
      "0005_calendar_syncs_user_match_idx.sql",
      "0006_calendar_syncs_idempotencia.sql",
    ]) {
      await aplicar(DB, f);
    }

    await DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES ('u1','a@a','A','microsoft','m1')").run();
    await DB.prepare("INSERT INTO leagues (id, name, country, external_id, season, is_active) VALUES ('l1','L','AR','e',2026,1)").run();
    for (const id of ["t1", "t2"]) {
      await DB.prepare("INSERT INTO teams (id, external_id, name, league_id) VALUES (?, ?, ?, 'l1')").bind(id, `e-${id}`, id).run();
    }
    for (const id of ["m1", "m2", "m3", "m4"]) {
      await DB.prepare(
        "INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status) VALUES (?, ?, 't1','t2','l1', 1800000000, 'scheduled')"
      ).bind(id, `e-${id}`).run();
    }
    const fila = (id: string, match: string, provider: string, status: string, ev: string | null) =>
      DB.prepare(
        "INSERT INTO calendar_syncs (id, user_id, match_id, provider, status, external_event_id) VALUES (?, 'u1', ?, ?, ?, ?)"
      ).bind(id, match, provider, status, ev).run();
    await fila("ms-synced", "m1", "microsoft", "synced", "ev1");
    await fila("ms-detached", "m2", "microsoft", "detached", null);
    await fila("ms-pending", "m3", "microsoft", "pending", null);
    await fila("g-synced", "m4", "google", "synced", "ev4");

    await aplicar(DB, "0007_outlook_utc_reconcile.sql");
  });
  afterAll(async () => {
    await mf.dispose();
  });

  const estado = async (id: string) =>
    (await DB.prepare("SELECT status FROM calendar_syncs WHERE id = ?").bind(id).first<{ status: string }>())?.status;

  it("marca needs_update el evento sincronizado de Outlook", async () => {
    expect(await estado("ms-synced")).toBe("needs_update");
  });

  it("no toca los eventos de Outlook que el usuario borró ni los pendientes", async () => {
    expect(await estado("ms-detached")).toBe("detached");
    expect(await estado("ms-pending")).toBe("pending");
  });

  it("no toca los eventos de Google", async () => {
    expect(await estado("g-synced")).toBe("synced");
  });
});
