// D1 efímera en memoria (Miniflare) con todas las migraciones de drizzle/migrations aplicadas.
// No toca la base local de desarrollo ni la de producción.
import { Miniflare } from "miniflare";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1Database } from "@cloudflare/workers-types";

const DIR_MIGRACIONES = join(process.cwd(), "drizzle", "migrations");

export interface TestDb {
  DB: D1Database;
  dispose: () => Promise<void>;
}

export async function createTestDb(): Promise<TestDb> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok'); } }",
    d1Databases: { DB: "fisture-test" },
  });
  try {
    const DB = (await mf.getD1Database("DB")) as unknown as D1Database;
    const archivos = readdirSync(DIR_MIGRACIONES).filter((f) => f.endsWith(".sql")).sort();
    for (const archivo of archivos) {
      const sql = readFileSync(join(DIR_MIGRACIONES, archivo), "utf8")
        .split(/\r?\n/).filter((l) => !l.trim().startsWith("--")).join("\n");
      // Una sentencia por prepare. Un batch por migración reduce el IPC con workerd.
      const statements = sql.split(";").map((s) => s.trim()).filter(Boolean).map((s) => DB.prepare(s));
      if (statements.length) await DB.batch(statements);
    }
    return { DB, dispose: () => mf.dispose() };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
