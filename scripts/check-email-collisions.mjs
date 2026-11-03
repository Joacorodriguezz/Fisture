// Pre-chequeo obligatorio antes del PR de release que incluye la migración 0010 (docs/18, docs/23 §6).
// La migración normaliza users.email (lower(trim)) y crea un índice único sobre lower(email): si dos usuarios
// difieren solo en mayúsculas o espacios, aborta y traba deploy.yml / staging.yml. Este script busca esas
// colisiones en las bases remotas, solo con lectura. Sale con código 1 si encuentra alguna.
//
// Uso: node scripts/check-email-collisions.mjs [fisture-db] [fisture-staging]
// Requiere sesión de wrangler (CLOUDFLARE_API_TOKEN o `wrangler login`).
import { execFileSync } from "node:child_process";

const SQL = "SELECT lower(trim(email)) AS e, COUNT(*) AS c FROM users GROUP BY e HAVING c > 1";
const bases = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["fisture-db", "fisture-staging"];

let colisiones = 0;
for (const base of bases) {
  let salida;
  try {
    salida = execFileSync("npx", ["wrangler", "d1", "execute", base, "--remote", "--json", "--command", SQL], {
      encoding: "utf8",
      shell: process.platform === "win32",
    });
  } catch (error) {
    console.error(`No se pudo consultar ${base}: ${error.message}`);
    process.exit(2);
  }
  const filas = JSON.parse(salida).flatMap((r) => r.results ?? []);
  if (filas.length === 0) {
    console.log(`${base}: sin colisiones de email`);
    continue;
  }
  colisiones += filas.length;
  // Contiene emails (datos personales): se muestra en la terminal local y no se guarda ni se sube a ningún lado
  console.error(`${base}: ${filas.length} email(s) colisionan. NO se puede migrar hasta resolverlos (docs/23 §6):`);
  for (const f of filas) console.error(`  ${f.e} (${f.c} usuarios)`);
}
process.exit(colisiones > 0 ? 1 : 0);
