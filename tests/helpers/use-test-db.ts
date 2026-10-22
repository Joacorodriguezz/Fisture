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

// Vacía todas las tablas de la app sin depender de una lista hardcodeada: reintenta
// las que fallan por claves foráneas hasta que sus dependientes ya estén vacías.
async function vaciarTablas(DB: D1Database) {
  const { results } = await DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name <> 'd1_migrations'"
  ).all<{ name: string }>();
  let pendientes = results.map((r) => r.name);
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
