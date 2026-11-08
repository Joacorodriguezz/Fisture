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
import { getMatchCountsByDay, getMatchesInRange, getTeamUpcomingMatches } from "../../../src/lib/db/queries";

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
});
