// Etapa 1 de docs/19: subir drizzle-orm/drizzle-kit no debe cambiar el SQL que sale de drizzle/schema.ts.
// Se genera el esquema completo en un directorio vacío y se compara con el snapshot versionado
// (generado con drizzle-kit 0.28). Si cambia, revisar el diff antes de actualizar el snapshot.
//
// No se compara contra drizzle/migrations: las migraciones 0001 a 0008 se escribieron a mano y el
// snapshot de drizzle-kit quedó en la 0000, así que `db:generate` ya produce una migración nueva.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const RAIZ = resolve(import.meta.dirname, "../../..");

describe("SQL generado por drizzle-kit desde drizzle/schema.ts", () => {
  // Dentro del repo y con ruta relativa: drizzle-kit en Windows no acepta rutas absolutas en --out
  const salida = mkdtempSync(join(RAIZ, ".esquema-"));
  afterAll(() => rmSync(salida, { recursive: true, force: true }));

  it("no cambia con la versión de drizzle", async () => {
    execFileSync(
      process.execPath,
      [
        join(RAIZ, "node_modules/drizzle-kit/bin.cjs"),
        "generate",
        "--dialect", "sqlite",
        "--schema", "./drizzle/schema.ts",
        "--out", relative(RAIZ, salida),
      ],
      { cwd: RAIZ, stdio: "pipe", timeout: 60_000 }
    );

    const archivos = readdirSync(salida).filter((f) => f.endsWith(".sql"));
    expect(archivos).toHaveLength(1);
    await expect(readFileSync(join(salida, archivos[0]), "utf8").replace(/\r\n/g, "\n")).toMatchFileSnapshot(
      "__snapshots__/esquema-drizzle.sql"
    );
  }, 90_000);
});
