// Verifica el sync de competencias contra una D1 efímera (en memoria, vía Miniflare):
// aplica las migraciones, sincroniza contra ESPN y muestra qué quedó cargado.
// No toca la base local de desarrollo ni la de producción.
//
// Uso:
//   npm run sync:check                      # todas las competencias
//   npm run sync:check -- eng.1 arg.1       # solo algunas (slug de ESPN)
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MIGRACIONES = [
  "0001_add_multi_source_support.sql",
  "0002_preferences_and_sync_state.sql",
  "0003_league_teams.sql",
  "0004_sync_runs.sql",
  "0006_calendar_syncs_idempotencia.sql",
];

const salida = join(tmpdir(), "fisture-sync.bundle.mjs");
await build({
  entryPoints: ["src/lib/data-providers/sync.ts"],
  outfile: salida,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "error",
});
const { syncAllLeagues, syncSingleLeague } = await import(pathToFileURL(salida).href);

const mf = new Miniflare({
  modules: true,
  script: "export default { fetch() { return new Response('ok'); } }",
  d1Databases: { DB: "fisture-check" },
});
const DB = await mf.getD1Database("DB");

try {
  // Migraciones: una sentencia por prepare (D1 no admite varias en una sola)
  for (const archivo of MIGRACIONES) {
    const sql = readFileSync(`drizzle/migrations/${archivo}`, "utf8")
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n");
    for (const sentencia of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
      await DB.prepare(sentencia).run();
    }
  }

  const ids = process.argv.slice(2);
  const inicio = Date.now();
  const env = { DB };
  const resultados = ids.length
    ? await Promise.all(ids.map((id) => syncSingleLeague(env, id)))
    : await syncAllLeagues(env);

  // Segunda pasada sobre la misma base: no debe crear ni duplicar nada
  if (process.env.SYNC_TWICE) {
    const segunda = ids.length
      ? await Promise.all(ids.map((id) => syncSingleLeague(env, id)))
      : await syncAllLeagues(env);
    const suma = (campo) => segunda.reduce((n, r) => n + r[campo], 0);
    console.log(
      `Segunda pasada: equipos +${suma("teamsCreated")} ~${suma("teamsUpdated")} | partidos +${suma("matchesCreated")} ~${suma("matchesUpdated")}
`
    );
  }

  console.log("Resultado del sync:");
  for (const r of resultados) {
    console.log(
      `  ${r.league.padEnd(28)} equipos +${String(r.teamsCreated).padEnd(3)} partidos +${String(r.matchesCreated).padEnd(4)}` +
        (r.matchesSkipped ? ` omitidos ${r.matchesSkipped}` : "") +
        (r.errors.length ? `  ERRORES: ${r.errors.slice(0, 2).join(" | ")}` : "")
    );
  }
  console.log(`  (${((Date.now() - inicio) / 1000).toFixed(1)}s)\n`);

  const q = async (sql) => (await DB.prepare(sql).all()).results;
  console.log("Cargado en la base:");
  console.table(
    await q(`SELECT l.name AS competencia, l.season,
      (SELECT COUNT(*) FROM league_teams lt WHERE lt.league_id = l.id) AS equipos,
      (SELECT COUNT(*) FROM matches m WHERE m.league_id = l.id) AS partidos,
      (SELECT COUNT(*) FROM matches m WHERE m.league_id = l.id AND m.date_time >= strftime('%s','now')) AS futuros,
      (SELECT strftime('%Y-%m-%d', MAX(m.date_time), 'unixepoch') FROM matches m WHERE m.league_id = l.id) AS hasta
    FROM leagues l ORDER BY l.name`)
  );
  console.log("Muestra (próximos partidos por competencia):");
  console.table(
    await q(`SELECT competencia, fecha, local, visitante, ronda, estado FROM (
      SELECT l.name AS competencia, strftime('%Y-%m-%d %H:%M', m.date_time, 'unixepoch') AS fecha,
             h.name AS local, a.name AS visitante, m.round AS ronda, m.status AS estado,
             ROW_NUMBER() OVER (PARTITION BY l.id ORDER BY m.date_time) AS n
      FROM matches m JOIN leagues l ON l.id = m.league_id
      JOIN teams h ON h.id = m.home_team_id JOIN teams a ON a.id = m.away_team_id
      WHERE m.date_time >= strftime('%s','now')
    ) WHERE n <= 2 ORDER BY competencia, fecha`)
  );

  console.log("Integridad:");
  const [sinEquipo] = await q(`SELECT COUNT(*) AS n FROM matches m
    LEFT JOIN teams h ON h.id = m.home_team_id LEFT JOIN teams a ON a.id = m.away_team_id
    WHERE h.id IS NULL OR a.id IS NULL`);
  const [placeholder] = await q("SELECT COUNT(*) AS n FROM teams WHERE name LIKE 'TBD%' OR name LIKE 'Winner%'");
  const [dobles] = await q(`SELECT COUNT(*) AS n FROM (SELECT name FROM teams GROUP BY name HAVING COUNT(*) > 1)`);
  const [marcadorFuturo] = await q(`SELECT COUNT(*) AS n FROM matches
    WHERE status = 'scheduled' AND (home_score IS NOT NULL OR away_score IS NOT NULL)`);
  if (dobles.n > 0) {
    console.log("  repetidos:", JSON.stringify(await q(`SELECT t.name, t.external_id, l.name AS liga FROM teams t
      JOIN leagues l ON l.id = t.league_id WHERE t.name IN (SELECT name FROM teams GROUP BY name HAVING COUNT(*) > 1)`)));
  }
  console.log(
    `  partidos con equipo inexistente: ${sinEquipo.n} | equipos placeholder: ${placeholder.n} | ` +
      `nombres de equipo repetidos: ${dobles.n} | programados con marcador: ${marcadorFuturo.n}`
  );

  const [tot] = await q("SELECT COUNT(*) AS equipos FROM teams");
  const [par] = await q("SELECT COUNT(*) AS partidos FROM matches");
  console.log(`Totales: ${tot.equipos} equipos únicos, ${par.partidos} partidos`);
} finally {
  await mf.dispose();
}
