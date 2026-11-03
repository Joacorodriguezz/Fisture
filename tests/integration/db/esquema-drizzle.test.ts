// Etapa 1 de docs/19: subir drizzle-orm/drizzle-kit no debe cambiar el SQL que sale de drizzle/schema.ts.
// Se genera el esquema completo en un directorio vacío y se compara con el snapshot versionado
// (generado con drizzle-kit 0.28). Si cambia, revisar el diff antes de actualizar el snapshot
// (`npx vitest run tests/integration/db -u`). Con CI=true un snapshot faltante falla, no se crea.
//
// No se compara contra drizzle/migrations: las migraciones 0001 a 0008 se escribieron a mano y el
// snapshot de drizzle-kit quedó en la 0000, así que `db:generate` ya produce una migración nueva.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RAIZ = resolve(import.meta.dirname, "../../..");

function generarEsquema(salida: string): void {
  try {
    execFileSync(
      process.execPath,
      [
        join(RAIZ, "node_modules/drizzle-kit/bin.cjs"),
        "generate",
        "--dialect", "sqlite",
        "--schema", "./drizzle/schema.ts",
        "--out", salida,
      ],
      { cwd: RAIZ, encoding: "utf8", stdio: "pipe", timeout: 60_000 }
    );
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    throw new Error(`drizzle-kit generate falló:\n${stdout}\n${stderr}`, { cause: error });
  }
}

describe("SQL generado por drizzle-kit desde drizzle/schema.ts", () => {
  it("no cambia con la versión de drizzle", async () => {
    // El directorio se crea acá y no al recolectar: `vitest list` (test:discover) no corre los hooks.
    // Va al temporal del sistema para no dejar basura en el repo si el proceso se corta.
    const salida = mkdtempSync(join(tmpdir(), "fisture-esquema-"));
    try {
      generarEsquema(salida);
      const archivos = readdirSync(salida).filter((f) => f.endsWith(".sql"));
      expect(archivos).toHaveLength(1);
      const generado = readFileSync(join(salida, archivos[0]), "utf8").replace(/\r\n/g, "\n");
      await expect(generado).toMatchFileSnapshot("__snapshots__/esquema-drizzle.sql");
    } finally {
      rmSync(salida, { recursive: true, force: true });
    }
  }, 90_000);
});
