import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function checkDiscovery(expectedFiles, collected) {
  assert(expectedFiles.length > 0, "No se encontraron archivos de test");
  const projects = new Map();
  for (const item of collected) {
    assert(["unit", "integration"].includes(item.projectName), `Proyecto desconocido: ${item.projectName}`);
    const names = projects.get(item.file) ?? new Set();
    names.add(item.projectName);
    projects.set(item.file, names);
  }
  for (const file of expectedFiles) {
    assert(projects.has(file), `Test omitido o sin casos descubiertos: ${file}`);
    assert.equal(projects.get(file).size, 1, `Test ejecutado por más de un proyecto: ${file}`);
  }
  for (const file of projects.keys()) assert(expectedFiles.includes(file), `Test fuera del inventario: ${file}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const normalize = (file) => relative(root, resolve(root, file)).replaceAll("\\", "/");
  const expected = readdirSync(resolve(root, "tests"), { recursive: true })
    .map((file) => `tests/${String(file).replaceAll("\\", "/")}`)
    .filter((file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file) && !file.startsWith("tests/e2e/"));
  const output = execFileSync(process.execPath, [resolve(root, "node_modules/vitest/vitest.mjs"), "list", "--json"], {
    cwd: root, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "inherit"], maxBuffer: 10 * 1024 * 1024,
  });
  const collected = JSON.parse(output).map((item) => ({ ...item, file: normalize(item.file) }));
  checkDiscovery(expected, collected);
  const counts = Object.fromEntries(["unit", "integration"].map((project) => [project, collected.filter((test) => test.projectName === project).length]));
  console.log(`Discovery OK: ${expected.length} archivos, ${counts.unit} unitarios y ${counts.integration} de integración; sin omisiones ni duplicaciones entre proyectos.`);
}
