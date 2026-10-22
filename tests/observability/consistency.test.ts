import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/d1";
import { useTestDb } from "../helpers/use-test-db";
import { createDb } from "../../src/lib/db";
import { checkConsistency } from "../../src/lib/observability/consistency";

const AHORA_S = 1_800_000_000; // epoch en segundos (date_time se guarda en segundos)
const AHORA_MS = AHORA_S * 1000;
const HORA = 3600;

describe("checkConsistency", () => {
  const t = useTestDb();

  const liga = (id: string, activa = 1) =>
    t.DB.prepare("INSERT INTO leagues (id, name, country, external_id, season, is_active) VALUES (?, ?, 'AR', ?, 2026, ?)")
      .bind(id, `Liga ${id}`, `ext-${id}`, activa)
      .run();
  const equipo = (id: string, leagueId = "l1") =>
    t.DB.prepare("INSERT INTO teams (id, external_id, name, league_id) VALUES (?, ?, ?, ?)")
      .bind(id, `ext-${id}`, `Equipo ${id}`, leagueId)
      .run();
  const partido = (
    id: string,
    o: { home?: string; away?: string; league?: string; date?: number; status?: string; hs?: number | null; as?: number | null } = {}
  ) =>
    t.DB.prepare(
      "INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status, home_score, away_score) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        id,
        `ext-${id}`,
        o.home ?? "t1",
        o.away ?? "t2",
        o.league ?? "l1",
        o.date ?? AHORA_S + 24 * HORA,
        o.status ?? "scheduled",
        o.hs === undefined ? null : o.hs,
        o.as === undefined ? null : o.as
      )
      .run();

  beforeEach(async () => {
    await liga("l1");
    await equipo("t1");
    await equipo("t2");
    await equipo("t3");
  });

  const codigos = async () => (await checkConsistency(t.db, AHORA_MS)).map((i) => i.code);

  it("una base sana no devuelve hallazgos", async () => {
    await partido("m1");
    expect(await checkConsistency(t.db, AHORA_MS)).toEqual([]);
  });

  it("match_same_team: local igual a visitante", async () => {
    await partido("m1", { home: "t1", away: "t1" });
    const issues = await checkConsistency(t.db, AHORA_MS);
    expect(issues).toEqual([{ code: "match_same_team", severity: "error", count: 1, sample: ["m1"] }]);
  });

  it("match_missing_team: equipo inexistente", async () => {
    // D1 impone las claves foráneas, así que este caso solo se puede sembrar en una
    // base aparte con `matches` recreada sin FK (simula una base que quedó inconsistente).
    const aislada = await createTestDb();
    try {
      await aislada.DB.prepare("DROP TABLE matches").run();
      await aislada.DB.prepare(
        "CREATE TABLE matches (id TEXT PRIMARY KEY, external_id TEXT, home_team_id TEXT, away_team_id TEXT, league_id TEXT, date_time INTEGER, venue TEXT, status TEXT, home_score INTEGER, away_score INTEGER, round TEXT, source TEXT, updated_at INTEGER)"
      ).run();
      await aislada.DB.prepare(
        "INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status) VALUES ('m1', 'e1', 'fantasma', 'otro', 'l', ?, 'scheduled')"
      )
        .bind(AHORA_S + 24 * HORA)
        .run();
      const issues = await checkConsistency(createDb(aislada.DB), AHORA_MS);
      expect(issues.find((i) => i.code === "match_missing_team")).toMatchObject({
        severity: "error",
        count: 1,
        sample: ["m1"],
      });
    } finally {
      await aislada.dispose();
    }
  });

  it("stale_scheduled: programado y ya vencido hace más de 3 h", async () => {
    await partido("viejo", { date: AHORA_S - 4 * HORA });
    await partido("reciente", { date: AHORA_S - 1 * HORA, away: "t3" });
    const issues = await checkConsistency(t.db, AHORA_MS);
    expect(issues).toEqual([{ code: "stale_scheduled", severity: "warn", count: 1, sample: ["viejo"] }]);
  });

  it("duplicate_match: misma liga, equipos y fecha", async () => {
    await partido("a", { date: AHORA_S + HORA });
    await partido("b", { date: AHORA_S + HORA });
    const issues = await checkConsistency(t.db, AHORA_MS);
    expect(issues).toEqual([{ code: "duplicate_match", severity: "error", count: 1, sample: [expect.any(String)] }]);
  });

  it("empty_league: competencia activa sin partidos (las inactivas se ignoran)", async () => {
    await liga("vacia");
    await liga("inactiva", 0);
    await partido("m1");
    const issues = await checkConsistency(t.db, AHORA_MS);
    expect(issues).toEqual([{ code: "empty_league", severity: "warn", count: 1, sample: ["vacia"] }]);
  });

  it("finished_without_score: finalizado sin marcador", async () => {
    await partido("m1", { status: "finished", date: AHORA_S - 10 * HORA, hs: 2, as: null });
    await partido("m2", { status: "finished", date: AHORA_S - 10 * HORA, away: "t3", hs: 1, as: 0 });
    const issues = await checkConsistency(t.db, AHORA_MS);
    expect(issues).toEqual([{ code: "finished_without_score", severity: "warn", count: 1, sample: ["m1"] }]);
  });

  it("el sample se limita a 5 ids pero count es el total", async () => {
    for (let i = 0; i < 8; i++) await partido(`s${i}`, { home: "t1", away: "t1", date: AHORA_S + i * HORA });
    const issue = (await checkConsistency(t.db, AHORA_MS)).find((i) => i.code === "match_same_team")!;
    expect(issue.count).toBe(8);
    expect(issue.sample).toHaveLength(5);
  });

  it("puede devolver varios hallazgos a la vez", async () => {
    await partido("m1", { home: "t1", away: "t1" });
    await partido("m2", { date: AHORA_S - 5 * HORA });
    expect((await codigos()).sort()).toEqual(["match_same_team", "stale_scheduled"]);
  });
});
