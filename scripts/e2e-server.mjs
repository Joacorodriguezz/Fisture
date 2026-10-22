// Build real de Astro en Pages local; D1/KV y sesiones viven en un directorio nuevo por corrida.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { connectHeadlessInspector } from "./e2e-inspector.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
if (!existsSync(join(dist, "_worker.js"))) throw new Error("Ejecutar npm run build antes de los E2E");
const taskDir = mkdtempSync(join(tmpdir(), "fisture-e2e-"));
const storage = join(taskDir, "state");
const wrangler = join(root, "node_modules", "wrangler", "bin", "wrangler.js");
const env = { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" };
// No carga config, secretos ni bindings remotos del directorio del proyecto.
writeFileSync(join(taskDir, "wrangler.toml"), `
name = "fisture-e2e"
compatibility_date = "2024-11-01"
pages_build_output_dir = ${JSON.stringify(dist.replaceAll("\\", "/"))}
[[d1_databases]]
binding = "DB"
database_name = "fisture-e2e"
database_id = "00000000-0000-0000-0000-000000000001"
migrations_dir = ${JSON.stringify(join(root, "drizzle", "migrations").replaceAll("\\", "/"))}
[[kv_namespaces]]
binding = "KV"
id = "00000000000000000000000000000001"
[vars]
ENVIRONMENT = "test"
PUBLIC_APP_URL = "http://127.0.0.1:4322"
ADMIN_SECRET = "local-e2e-admin"
`);

function run(args) {
  execFileSync(process.execPath, [wrangler, ...args], { cwd: taskDir, env, stdio: "pipe", timeout: 60_000 });
}
function clean() {
  // Solo puede borrar el directorio temporal creado por esta ejecución.
  if (dirname(taskDir) === tmpdir() && taskDir.startsWith(join(tmpdir(), "fisture-e2e-"))) {
    rmSync(taskDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

let child;
let inspector;
try {
  run(["d1", "migrations", "apply", "fisture-e2e", "--local", "--persist-to", storage]);
  const kickoff = Math.floor(Date.now() / 1000) + 86_400;
  const now = Date.now();
  const sql = [
    "UPDATE leagues SET is_active = 0;",
    "INSERT INTO leagues (id, external_id, name, country, season, source, is_active) VALUES ('e2e-league', 'e2e:league', 'Liga E2E', 'Argentina', 2026, 'espn', 1);",
    "INSERT INTO teams (id, external_id, name, short_name, league_id, source) VALUES ('river', 'e2e:river', 'River Plate', 'RIV', 'e2e-league', 'espn'), ('boca', 'e2e:boca', 'Boca Juniors', 'BOC', 'e2e-league', 'espn');",
    "INSERT INTO league_teams (league_id, team_id) VALUES ('e2e-league', 'river'), ('e2e-league', 'boca');",
    "INSERT INTO leagues (id, external_id, name, country, season, source, is_active) VALUES ('neutral-league', 'e2e:neutral', 'Liga neutral', 'Argentina', 2026, 'espn', 1);",
    "INSERT INTO teams (id, external_id, name, short_name, league_id, source) VALUES ('neutral-home', 'e2e:neutral-home', 'Equipo neutral local', 'NEU', 'neutral-league', 'espn'), ('neutral-away', 'e2e:neutral-away', 'Equipo neutral visitante', 'VIS', 'neutral-league', 'espn');",
    `INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status) VALUES ('neutral-match', 'e2e:neutral-match', 'neutral-home', 'neutral-away', 'neutral-league', ${kickoff}, 'scheduled');`,
    `INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, venue, status) VALUES ('superclasico', 'e2e:match', 'river', 'boca', 'e2e-league', ${kickoff}, 'Monumental', 'scheduled');`,
    `INSERT INTO sync_runs (id, trigger, started_at, finished_at, status, duration_ms, results, issues) VALUES ('e2e-sync', 'admin', ${now}, ${now}, 'success', 1, '[]', '[]');`,
  ];
  const sessions = [];
  for (const project of ["desktop", "mobile"]) {
    for (const scenario of ["follow", "preferences", "calendar", "logout", "navigation", "errors", "calendar-states", "responsive-menu", "responsive-today"]) {
      for (let retry = 0; retry <= 1; retry++) {
        const id = `${project}-${scenario}-${retry}`;
        sql.push(`INSERT INTO users (id, email, name, provider, provider_id) VALUES ('${id}', '${id}@example.test', 'Persona E2E', 'google', '${id}');`);
        sessions.push({ key: `session:e2e-${id}`, value: id });
        if (["calendar", "navigation", "errors", "calendar-states", "responsive-today"].includes(scenario)) {
          sql.push(`INSERT INTO user_teams (id, user_id, team_id, auto_sync) VALUES ('follow-${id}', '${id}', 'river', 0);`);
        }
        if (scenario === "calendar-states") {
          for (const state of ["detached", "cancelled", "synced"]) {
            const matchId = `${id}-${state}`;
            const matchState = state === "cancelled" ? "cancelled" : "scheduled";
            sql.push(`INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, venue, status) VALUES ('${matchId}', '${matchId}', 'river', 'boca', 'e2e-league', ${kickoff}, 'Monumental', '${matchState}');`);
            sql.push(`INSERT INTO calendar_syncs (id, user_id, match_id, provider, status, synced_date_time, synced_state, synced_venue) VALUES ('sync-${matchId}', '${id}', '${matchId}', 'google', '${state}', ${kickoff - 3600}, '${matchState}', 'Monumental');`);
          }
        }
      }
    }
  }
  writeFileSync(join(taskDir, "seed.sql"), sql.join("\n"));
  writeFileSync(join(taskDir, "sessions.json"), JSON.stringify(sessions));
  run(["d1", "execute", "fisture-e2e", "--local", "--persist-to", storage, "--file", join(taskDir, "seed.sql")]);
  // Verifica que el ledger de migraciones no reaplique migraciones históricas sobre datos existentes.
  run(["d1", "migrations", "apply", "fisture-e2e", "--local", "--persist-to", storage]);
  run(["kv:bulk", "put", join(taskDir, "sessions.json"), "--binding", "KV", "--local", "--persist-to", storage]);
  const inspectorPort = await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
  child = spawn(process.execPath, [wrangler, "pages", "dev", dist, "--ip", "127.0.0.1", "--port", "4322", "--inspector-port", String(inspectorPort), "--persist-to", storage], { cwd: taskDir, env, stdio: "inherit" });
  child.on("error", (error) => { console.error(error); process.exitCode = 1; });
  child.on("exit", (code) => { inspector?.close(); clean(); process.exit(code ?? 1); });
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  inspector = await connectHeadlessInspector(inspectorPort, { onFailure: (error) => { console.error(error); child.kill(); } });
  console.log("FISTURE_E2E_READY");
} catch (error) {
  inspector?.close();
  if (child) child.kill();
  else clean();
  throw error;
}
