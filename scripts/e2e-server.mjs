// Build real de Astro en Pages local; D1/KV (con las sesiones en D1) viven en un directorio nuevo por corrida.
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { createHash, randomBytes } from "node:crypto";
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
GOOGLE_SITE_VERIFICATION = "e2e-google-verificacion"
ADMIN_SECRET = "local-e2e-admin"
OAUTH_STATE_SECRET = "local-e2e-oauth-state-secret-0123456789"
TOKEN_ENCRYPTION_KEY = "${randomBytes(32).toString("base64")}"
GOOGLE_CLIENT_ID = "e2e-google-id"
GOOGLE_CLIENT_SECRET = "e2e-google-secret"
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
    // URLs con nombre (docs/33 D9): en River, Boca y la liga E2E el slug es igual al id, así /equipos/river
    // sigue siendo la URL canónica de los tests. La liga y el local neutrales tienen un slug distinto del id
    // (su URL por id responde 301); el visitante neutral y "sin-partidos" no tienen slug (se sirven por id).
    "INSERT INTO leagues (id, external_id, name, country, season, source, is_active, slug) VALUES ('e2e-league', 'e2e:league', 'Liga E2E', 'Argentina', 2026, 'espn', 1, 'e2e-league');",
    "INSERT INTO teams (id, external_id, name, short_name, league_id, source, slug) VALUES ('river', 'e2e:river', 'River Plate', 'RIV', 'e2e-league', 'espn', 'river'), ('boca', 'e2e:boca', 'Boca Juniors', 'BOC', 'e2e-league', 'espn', 'boca');",
    "INSERT INTO league_teams (league_id, team_id) VALUES ('e2e-league', 'river'), ('e2e-league', 'boca');",
    // Copa no destacada (docs/22): no se lista en /ligas pero aparece en la página del equipo
    "INSERT INTO leagues (id, external_id, name, country, season, source, is_active, is_featured) VALUES ('e2e-copa', 'e2e:copa', 'Copa E2E', 'Argentina', 2026, 'espn', 1, 0);",
    "INSERT INTO league_teams (league_id, team_id) VALUES ('e2e-copa', 'river');",
    "INSERT INTO leagues (id, external_id, name, country, season, source, is_active, slug) VALUES ('neutral-league', 'e2e:neutral', 'Liga neutral', 'Argentina', 2026, 'espn', 1, 'liga-neutral');",
    "INSERT INTO teams (id, external_id, name, short_name, league_id, source, slug) VALUES ('neutral-home', 'e2e:neutral-home', 'Equipo neutral local', 'NEU', 'neutral-league', 'espn', 'equipo-neutral-local'), ('neutral-away', 'e2e:neutral-away', 'Equipo neutral visitante', 'VIS', 'neutral-league', 'espn', NULL);",
    `INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status, round) VALUES ('neutral-match', 'e2e:neutral-match', 'neutral-home', 'neutral-away', 'neutral-league', ${kickoff}, 'scheduled', 'Fecha 3');`,
    `INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, venue, status) VALUES ('superclasico', 'e2e:match', 'river', 'boca', 'e2e-league', ${kickoff}, 'Monumental', 'scheduled');`,
    // Últimos resultados del equipo (docs/33 D3): uno con marcador y uno terminado sin marcador cargado
    `INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, venue, status, home_score, away_score) VALUES ('superclasico-ida', 'e2e:match-ida', 'boca', 'river', 'e2e-league', ${kickoff - 5 * 86_400}, 'La Bombonera', 'finished', 1, 2), ('superclasico-sin-marcador', 'e2e:match-sin-marcador', 'river', 'boca', 'e2e-league', ${kickoff - 10 * 86_400}, 'Monumental', 'finished', NULL, NULL);`,
    // Equipo sin ningún partido (docs/33 D8): su página va con noindex y no entra al sitemap
    "INSERT INTO teams (id, external_id, name, short_name, league_id, source) VALUES ('sin-partidos', 'e2e:sin-partidos', 'Equipo sin partidos', 'SIN', 'e2e-league', 'espn');",
    "INSERT INTO league_teams (league_id, team_id) VALUES ('e2e-league', 'sin-partidos');",
    // Equipos de la misma liga (docs/33 D10): Talleres tiene un slug distinto del id y juega la liga E2E,
    // pero su liga principal es la copa no destacada, así que su página no muestra la sección
    "INSERT INTO teams (id, external_id, name, short_name, league_id, source, slug) VALUES ('talleres-id', 'e2e:talleres', 'Talleres E2E', 'TAL', 'e2e-copa', 'espn', 'talleres-e2e');",
    "INSERT INTO league_teams (league_id, team_id) VALUES ('e2e-league', 'talleres-id'), ('e2e-copa', 'talleres-id');",
    // Selecciones (docs/32 Fase B): entran por las Eliminatorias (destacada, plantel fijo) y juegan amistosos
    // (copa no destacada). Costa Rica es solo rival del amistoso: no se busca.
    "INSERT INTO leagues (id, external_id, name, country, season, source, is_active, slug) VALUES ('e2e-eliminatorias', 'fifa.worldq.conmebol', 'Eliminatorias Sudamericanas', 'Sudamérica', 2026, 'espn', 1, 'eliminatorias-sudamericanas');",
    "INSERT INTO leagues (id, external_id, name, country, season, source, is_active, is_featured) VALUES ('e2e-amistosos', 'fifa.friendly', 'Amistosos internacionales', 'Mundial', 2026, 'espn', 1, 0);",
    "INSERT INTO teams (id, external_id, name, short_name, country, league_id, source, slug) VALUES ('sel-uruguay', 'espn:212', 'Uruguay', 'URU', 'Sudamérica', 'e2e-eliminatorias', 'espn', 'uruguay'), ('sel-argentina', 'espn:202', 'Argentina', 'ARG', 'Sudamérica', 'e2e-eliminatorias', 'espn', 'argentina'), ('sel-costa-rica', 'espn:214', 'Costa Rica', 'CRC', NULL, 'e2e-amistosos', 'espn', NULL);",
    "INSERT INTO league_teams (league_id, team_id) VALUES ('e2e-eliminatorias', 'sel-uruguay'), ('e2e-eliminatorias', 'sel-argentina'), ('e2e-amistosos', 'sel-uruguay'), ('e2e-amistosos', 'sel-argentina'), ('e2e-amistosos', 'sel-costa-rica');",
    `INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, venue, status) VALUES ('amistoso-uruguay', 'e2e:amistoso-uruguay', 'sel-uruguay', 'sel-costa-rica', 'e2e-amistosos', ${kickoff + 3600}, 'Estadio Centenario', 'scheduled');`,
    `INSERT INTO sync_runs (id, trigger, started_at, finished_at, status, duration_ms, results, issues) VALUES ('e2e-sync', 'admin', ${now}, ${now}, 'success', 1, '[]', '[]');`,
  ];
  // Prode (docs/38): liga inactiva y no destacada (no sale en ninguna lista pública) con tres cruces manuales:
  // uno abierto (en 30 días), uno cerrado (empezó hace 1 h, sin resultado) y uno terminado 2-1.
  sql.push(
    "INSERT INTO leagues (id, external_id, name, country, season, source, is_active, is_featured) VALUES ('prode-liga', 'e2e:prode-liga', 'Liga Prode E2E', 'Argentina', 2026, 'espn', 0, 0);",
    "INSERT INTO teams (id, external_id, name, short_name, league_id, source) VALUES ('prode-a', 'e2e:prode-a', 'Prode Alfa', 'PRA', 'prode-liga', 'espn'), ('prode-b', 'e2e:prode-b', 'Prode Beta', 'PRB', 'prode-liga', 'espn');"
  );
  const prodeCruces = [
    ["prode-abierto", "scheduled", kickoff + 30 * 86_400, "NULL", "NULL"],
    ["prode-cerrado", "scheduled", Math.floor(now / 1000) - 3600, "NULL", "NULL"],
    ["prode-jugado", "finished", Math.floor(now / 1000) - 3 * 86_400, "2", "1"],
  ];
  for (const [mid, status, fecha, gl, gv] of prodeCruces) {
    sql.push(`INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status, home_score, away_score, round, source) VALUES ('${mid}', 'prode:${mid}', 'prode-a', 'prode-b', 'prode-liga', ${fecha}, '${status}', ${gl}, ${gv}, 'cuartos', 'manual');`);
    sql.push(`INSERT INTO prode_matches (match_id, fase, created_at) VALUES ('${mid}', 'cuartos', ${now});`);
  }
  const sessions = [];
  for (const project of ["desktop", "mobile", "webkit-mobile"]) {
    for (const scenario of ["delete-account", "delete-cancel", "follow", "preferences", "calendar", "logout", "navigation", "errors", "list-add", "calendar-states", "responsive-menu", "responsive-today", "responsive-today-chip", "responsive-today-mine", "quit", "unlink", "prode", "prode-invitado"]) {
      for (let retry = 0; retry <= 1; retry++) {
        const id = `${project}-${scenario}-${retry}`;
        sql.push(`INSERT INTO users (id, email, name, provider, provider_id) VALUES ('${id}', '${id}@example.test', 'Persona E2E', 'google', '${id}');`);
        sessions.push(id);
        if (["calendar", "navigation", "errors", "list-add", "calendar-states", "responsive-today", "responsive-today-chip", "responsive-today-mine"].includes(scenario)) {
          sql.push(`INSERT INTO user_teams (id, user_id, team_id, auto_sync) VALUES ('follow-${id}', '${id}', 'river', 0);`);
        }
        if (scenario === "prode" || scenario === "prode-invitado") {
          // Nombre visible único por usuario. El dueño ya pronosticó el partido terminado con el resultado
          // exacto (3 puntos) y es dueño de un grupo sembrado donde es el único integrante.
          const nombre = scenario === "prode" ? `Dueño ${id}` : `Invitado ${id}`;
          sql.push(`UPDATE users SET display_name = '${nombre}' WHERE id = '${id}';`);
          if (scenario === "prode") {
            sql.push(`INSERT INTO prode_predictions (user_id, match_id, home_goals, away_goals, created_at, updated_at) VALUES ('${id}', 'prode-jugado', 2, 1, ${now}, ${now});`);
            sql.push(`INSERT INTO prode_groups (id, name, invite_code, owner_id, created_at) VALUES ('grupo-${id}', 'Grupo sembrado ${id}', 'seed${id.replace(/[^A-Za-z0-9]/g, "")}', '${id}', ${now});`);
            sql.push(`INSERT INTO prode_group_members (group_id, user_id, joined_at) VALUES ('grupo-${id}', '${id}', ${now});`);
          }
        }
        if (scenario === "unlink") {
          // Dos proveedores vinculados: Google es el calendario activo y Microsoft se puede desvincular
          sql.push(`INSERT INTO oauth_identities (id, user_id, provider, provider_id, email) VALUES ('${id}', '${id}', 'google', '${id}', '${id}@example.test'), ('ms-${id}', '${id}', 'microsoft', 'ms-${id}', '${id}@example.test');`);
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
  // Las sesiones viven en D1 con el hash del token de la cookie (docs/21): cookie `e2e-<id>`
  const creada = Math.floor(now / 1000);
  for (const id of sessions) {
    const hash = createHash("sha256").update(`e2e-${id}`).digest("hex");
    sql.push(`INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES ('${hash}', '${id}', ${creada}, ${creada + 30 * 86400});`);
  }
  writeFileSync(join(taskDir, "seed.sql"), sql.join("\n"));
  run(["d1", "execute", "fisture-e2e", "--local", "--persist-to", storage, "--file", join(taskDir, "seed.sql")]);
  // Verifica que el ledger de migraciones no reaplique migraciones históricas sobre datos existentes.
  run(["d1", "migrations", "apply", "fisture-e2e", "--local", "--persist-to", storage]);
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
