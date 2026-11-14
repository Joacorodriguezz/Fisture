// Guardia de lecturas (docs/30 D5): D1 cobra por fila leída y la cuota gratuita es de 5 M por día
// para toda la cuenta. Las consultas calientes tienen que usar un índice sobre `matches`; un
// `SCAN matches` lee la tabla entera (~4 k filas hoy) en cada llamada.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import scoreboard from "../../fixtures/espn-scoreboard.json";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { createDb } from "../../../src/lib/db";
import { syncSingleLeague } from "../../../src/lib/data-providers/sync";
import { checkConsistency } from "../../../src/lib/observability/consistency";
import { getEquiposDeLaLiga, getLeagueBySlugOrId, getMatchCountsByDay, getMatchesInRange, getPaginasPublicas, getTeamBySlugOrId, getTeamRecentMatches, getTeamUpcomingMatches } from "../../../src/lib/db/queries";
import { asignarSlugsPendientes, slugsOcupados } from "../../../src/lib/db/slugs";

interface Consulta {
  sql: string;
  params: unknown[];
}

// D1 que anota cada sentencia con sus parámetros
function espiar(DB: D1Database) {
  const consultas: Consulta[] = [];
  const espia = new Proxy(DB, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          const consulta: Consulta = { sql, params: [] };
          consultas.push(consulta);
          const stmt = target.prepare(sql);
          return new Proxy(stmt, {
            get(s, p) {
              if (p === "bind") return (...params: unknown[]) => ((consulta.params = params), s.bind(...params));
              const valor = Reflect.get(s, p);
              return typeof valor === "function" ? valor.bind(s) : valor;
            },
          });
        };
      }
      const valor = Reflect.get(target, prop);
      return typeof valor === "function" ? valor.bind(target) : valor;
    },
  });
  return { DB: espia, consultas };
}

describe("planes de las consultas calientes", () => {
  const t = useTestDb();
  relojFijo();

  beforeEach(async () => {
    const data = structuredClone(scoreboard);
    data.events[0].date = new Date(AHORA.getTime() + DIA_MS).toISOString();
    data.events[0].season.year = AHORA.getUTCFullYear();
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(data)));
    await syncSingleLeague({ DB: t.DB }, "arg.1");
  });

  async function plan({ sql, params }: Consulta): Promise<string[]> {
    const { results } = await t.DB.prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .bind(...params)
      .all<{ detail: string }>();
    return results.map((r) => r.detail);
  }

  async function capturar(fn: (DB: D1Database) => Promise<unknown>, filtro: (sql: string) => boolean) {
    const { DB, consultas } = espiar(t.DB);
    await fn(DB);
    const elegidas = consultas.filter((c) => filtro(c.sql));
    expect(elegidas.length, "la consulta no se ejecutó").toBeGreaterThan(0);
    return elegidas;
  }

  const recorreMatches = (detalle: string) => /^SCAN (matches|m)\b/.test(detalle);

  async function sinRecorrerMatches(consultas: Consulta[]) {
    for (const c of consultas) {
      const pasos = await plan(c);
      expect(pasos.filter(recorreMatches), `${c.sql}\n${pasos.join("\n")}`).toEqual([]);
    }
  }

  it("el sync busca los partidos existentes de la competencia por índice", async () => {
    const consultas = await capturar(
      (DB) => syncSingleLeague({ DB }, "arg.1"),
      (sql) => sql.startsWith("select") && sql.includes('from "matches" where ("matches"."league_id" = ?')
    );
    await sinRecorrerMatches(consultas);
  });

  it("el chequeo de competencias vacías busca por índice", async () => {
    const consultas = await capturar(
      (DB) => checkConsistency(createDb(DB)),
      (sql) => sql.includes("FROM matches m WHERE m.league_id = l.id")
    );
    await sinRecorrerMatches(consultas);
  });

  it("los partidos de un equipo, de un rango y el conteo por día usan índices", async () => {
    const [equipo] = (await t.DB.prepare("SELECT id FROM teams LIMIT 1").all<{ id: string }>()).results;
    const desde = new Date(AHORA.getTime() - DIA_MS);
    const hasta = new Date(AHORA.getTime() + 7 * DIA_MS);

    const consultas = await capturar(
      async (DB) => {
        const db = createDb(DB);
        await getTeamUpcomingMatches(db, equipo.id);
        await getMatchesInRange(db, desde, hasta);
        await getMatchCountsByDay(db, desde, hasta);
      },
      (sql) => sql.includes('from "matches"')
    );
    expect(consultas).toHaveLength(3);
    await sinRecorrerMatches(consultas);
  });

  // docs/33 D3: los últimos resultados de un equipo van por los índices de local y visitante, no por
  // idx_matches_date (recorrería hacia atrás los partidos jugados de todos los equipos)
  it("los últimos resultados de un equipo usan los índices de local y visitante", async () => {
    const [equipo] = (await t.DB.prepare("SELECT id FROM teams LIMIT 1").all<{ id: string }>()).results;
    const [consulta] = await capturar(
      (DB) => getTeamRecentMatches(createDb(DB), equipo.id),
      (sql) => sql.includes('from "matches"')
    );
    const pasos = (await plan(consulta)).join("\n");
    expect(pasos).not.toMatch(/^SCAN (matches|m)\b/m);
    expect(pasos).toContain("idx_matches_home_team");
    expect(pasos).toContain("idx_matches_away_team");
  });

  // docs/33 D8: el sitemap deja afuera a los equipos sin partidos con un EXISTS por índice, en la
  // misma consulta de equipos (no una consulta por equipo)
  it("el sitemap busca los partidos de cada equipo por índice", async () => {
    const consultas = await capturar(
      (DB) => getPaginasPublicas(createDb(DB), AHORA),
      (sql) => sql.includes('from "league_teams"') && sql.includes('from "matches"')
    );
    expect(consultas).toHaveLength(1);
    const pasos = (await plan(consultas[0])).join("\n");
    expect(pasos).not.toMatch(/^SCAN (matches|m)\b/m);
    expect(pasos).toContain("idx_matches_home_team");
    expect(pasos).toContain("idx_matches_away_team");
  });

  // docs/33 D10: los otros equipos de la liga salen de league_teams por su clave primaria (league_id
  // primero) y cada equipo por la de teams; ninguna de las dos tablas se recorre entera
  it("los equipos de la misma liga usan la clave primaria de league_teams y de teams", async () => {
    const [fila] = (await t.DB.prepare("SELECT league_id AS leagueId, team_id AS teamId FROM league_teams LIMIT 1")
      .all<{ leagueId: string; teamId: string }>()).results;
    const consultas = await capturar(
      (DB) => getEquiposDeLaLiga(createDb(DB), fila.leagueId, fila.teamId),
      (sql) => sql.includes('from "league_teams"')
    );
    expect(consultas).toHaveLength(1);
    const pasos = (await plan(consultas[0])).join("\n");
    expect(pasos, pasos).not.toMatch(/^SCAN (league_teams|teams)\b/m);
    expect(pasos).toContain("SEARCH league_teams USING COVERING INDEX sqlite_autoindex_league_teams_1 (league_id=?)");
    expect(pasos).toContain("SEARCH teams USING INDEX sqlite_autoindex_teams_1 (id=?)");
  });

  // docs/33 D9: la página resuelve slug o id, el sync y el backfill leen los slugs ocupados y el backfill
  // busca y cuenta las filas sin slug: todo por el índice único de slug o la clave primaria, sin SCAN
  it("las consultas de slugs usan el índice de slug o la clave primaria", async () => {
    const consultas = await capturar(
      async (DB) => {
        const db = createDb(DB);
        await getTeamBySlugOrId(db, "river-plate");
        await getLeagueBySlugOrId(db, "liga-profesional-argentina");
        await slugsOcupados(db, "teams", ["river-plate", "boca-juniors"]);
        await asignarSlugsPendientes(db);
      },
      (sql) => /from "(teams|leagues)"/.test(sql) && sql.includes("slug")
    );
    expect(consultas.length).toBeGreaterThanOrEqual(6);
    for (const c of consultas.filter((c) => c.sql.startsWith("select"))) {
      const pasos = (await plan(c)).join("\n");
      expect(pasos, `${c.sql}\n${pasos}`).not.toMatch(/^SCAN (teams|leagues)\b/m);
    }
  });
});
