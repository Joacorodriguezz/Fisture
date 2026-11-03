// Presupuesto de subrequests de una invocación (docs/17 B5, D4): cada consulta D1 y cada llamada al
// calendario suma 1, y el lote se corta antes de pasar el tope de Workers Free (50).
import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { contarCliente, contarD1, PRESUPUESTO_SUBREQUESTS, Presupuesto } from "../../../src/lib/calendar/presupuesto";
import type { CalendarClient } from "../../../src/lib/calendar/clients";

// D1 mínima: registra qué se ejecutó y cuántas sentencias tuvo cada batch
function d1Falsa() {
  const log: string[] = [];
  const stmt = (sql: string) => {
    const s = {
      sql,
      bind: (..._a: unknown[]) => s,
      run: async () => (log.push(`run:${sql}`), { success: true }),
      all: async () => (log.push(`all:${sql}`), { results: [] }),
      first: async () => (log.push(`first:${sql}`), null),
      raw: async () => (log.push(`raw:${sql}`), []),
    };
    return s;
  };
  const DB = {
    prepare: (sql: string) => stmt(sql),
    batch: async (stmts: { sql: string }[]) => (log.push(`batch:${stmts.map((s) => s.sql).join("|")}`), stmts.map(() => ({ success: true }))),
  };
  return { DB: DB as unknown as D1Database, log };
}

describe("Presupuesto", () => {
  it("el tope por defecto deja margen bajo las 50 subrequests de Workers Free", () => {
    expect(PRESUPUESTO_SUBREQUESTS).toBeLessThan(50);
  });

  it("alcanza descuenta lo gastado y la reserva", () => {
    const p = new Presupuesto(10, 3);
    expect(p.restante).toBe(7);
    expect(p.alcanza(7)).toBe(true);
    p.gastar(2);
    expect(p.usado).toBe(2);
    expect(p.restante).toBe(5);
    expect(p.alcanza(6)).toBe(false);
  });

  it("gastar acepta pasarse del tope (lo ya hecho se cuenta) y restante no baja de cero", () => {
    const p = new Presupuesto(5);
    p.gastar(8);
    expect(p.usado).toBe(8);
    expect(p.restante).toBe(0);
    expect(p.alcanza(1)).toBe(false);
  });
});

describe("contarD1", () => {
  it("suma 1 por cada consulta ejecutada (run, all, first, raw), no por preparar ni bindear", async () => {
    const { DB, log } = d1Falsa();
    const p = new Presupuesto(50);
    const d1 = contarD1(DB, p);
    const s = d1.prepare("SELECT 1").bind("x");
    expect(p.usado).toBe(0);
    await s.run();
    await s.all();
    await s.first();
    await s.raw();
    expect(p.usado).toBe(4);
    expect(log).toHaveLength(4);
  });

  it("un batch cuenta una consulta por sentencia (criterio conservador) y ejecuta las sentencias reales", async () => {
    const { DB, log } = d1Falsa();
    const p = new Presupuesto(50);
    const d1 = contarD1(DB, p);
    await d1.batch([d1.prepare("A").bind(), d1.prepare("B")]);
    expect(p.usado).toBe(2);
    expect(log).toEqual(["batch:A|B"]);
  });
});

describe("contarCliente", () => {
  const base: CalendarClient = {
    create: async () => "ev",
    update: async () => {},
    remove: async () => {},
    overlaps: async () => [],
  };

  it("create cuesta 2 (puede adoptar el evento con un GET) y el resto 1; cuenta también si falla", async () => {
    const p = new Presupuesto(50);
    const c = contarCliente({ ...base, update: async () => { throw new Error("x"); } }, p);
    expect(await c.create("t", {} as never, {} as never, { userId: "u" })).toBe("ev");
    expect(p.usado).toBe(2);
    await expect(c.update("t", "e", {} as never, {} as never)).rejects.toThrow("x");
    await c.remove("t", "e");
    await c.overlaps("t", {} as never, "e");
    expect(p.usado).toBe(5);
  });
});
