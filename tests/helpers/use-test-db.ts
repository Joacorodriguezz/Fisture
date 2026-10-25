// Ciclo de vida de una D1 efímera para un archivo de tests: se crea una vez (beforeAll),
// se vacía antes de cada test (beforeEach) y se libera al final (afterAll).
import { afterAll, beforeAll, beforeEach } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { createDb, type Database } from "../../src/lib/db";
import { createTestDb, type TestDb } from "./d1";

export interface UseTestDb {
  readonly DB: D1Database;
  readonly db: Database;
}

// Tablas de la app, descubiertas una sola vez por D1 (sin lista hardcodeada)
const tablasPorDb = new WeakMap<D1Database, string[]>();
async function tablasDe(DB: D1Database): Promise<string[]> {
  let tablas = tablasPorDb.get(DB);
  if (!tablas) {
    const { results } = await DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'"
    ).all<{ name: string }>();
    tablas = results.map((r) => r.name);
    tablasPorDb.set(DB, tablas);
  }
  return tablas;
}

// Vacía todas las tablas en un solo batch (una transacción): con las claves foráneas diferidas
// hasta el commit el orden de borrado no importa. Si el batch falla, cae al borrado tabla por
// tabla reintentando las que fallan por claves foráneas.
async function vaciarTablas(DB: D1Database) {
  const tablas = await tablasDe(DB);
  try {
    await DB.batch([DB.prepare("PRAGMA defer_foreign_keys = on"), ...tablas.map((t) => DB.prepare(`DELETE FROM "${t}"`))]);
    return;
  } catch {
    /* se reintenta tabla por tabla */
  }
  let pendientes = tablas;
  while (pendientes.length > 0) {
    const fallidas: string[] = [];
    for (const tabla of pendientes) {
      try {
        await DB.prepare(`DELETE FROM "${tabla}"`).run();
      } catch {
        fallidas.push(tabla);
      }
    }
    if (fallidas.length === pendientes.length) throw new Error(`No se pudo vaciar: ${fallidas.join(", ")}`);
    pendientes = fallidas;
  }
}

export function useTestDb(): UseTestDb {
  let t: TestDb;
  let db: Database;

  beforeAll(async () => {
    t = await createTestDb();
    db = createDb(t.DB);
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    await vaciarTablas(t.DB);
  });

  return {
    get DB() {
      return t.DB;
    },
    get db() {
      return db;
    },
  };
}
