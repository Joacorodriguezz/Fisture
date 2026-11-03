// Mantiene vivos los workflows programados (docs/17 B1, D7).
// GitHub desactiva los workflows con `schedule` tras 60 días sin actividad en el repo, sin avisar. Este
// script, que corre semanal desde .github/workflows/keepalive.yml:
//  1. vuelve a habilitar cada workflow programado (PUT .../enable, necesita `actions: write`): si GitHub
//     ya lo había desactivado por inactividad, lo reactiva; si estaba activo la llamada es inocua;
//  2. mira si el sync diario terminó bien en las últimas 72 h: es una señal independiente de la app.
// Sale con 1 si reactivó algo (había un hueco que hay que conocer) o si el sync está atrasado, para que
// el workflow abra un issue. El propio keepalive se puede desactivar: ver docs/17 §12 y docs/23.
import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WORKFLOWS_PROGRAMADOS = ["sync-cron.yml", "monitor.yml", "keepalive.yml"];
const MAX_EDAD_SYNC_MS = 72 * 3_600_000;

const ghReal = async (args) => (await execFileAsync("gh", args, { encoding: "utf8" })).stdout;

export async function mantenerVivos({
  repo,
  workflows = WORKFLOWS_PROGRAMADOS,
  gh = ghReal,
  ahora = Date.now,
  log = console.log,
  maxEdadSyncMs = MAX_EDAD_SYNC_MS,
} = {}) {
  if (!repo) throw new Error("Falta repo (owner/nombre)");
  const reactivados = [];

  for (const archivo of workflows) {
    const base = `repos/${repo}/actions/workflows/${archivo}`;
    const { state } = JSON.parse(await gh(["api", base]));
    if (state !== "active") {
      reactivados.push(archivo);
      log(`::warning::El workflow ${archivo} estaba en estado ${state}: se reactiva`);
    }
    try {
      await gh(["api", "-X", "PUT", `${base}/enable`]);
    } catch (error) {
      throw new Error(`No se pudo habilitar ${archivo}: falta el permiso actions: write o el workflow no existe (${error.message})`, { cause: error });
    }
  }

  const { workflow_runs: corridas } = JSON.parse(
    await gh(["api", `repos/${repo}/actions/workflows/sync-cron.yml/runs?status=success&per_page=1`])
  );
  const ultimoSyncExitoso = corridas?.[0]?.updated_at ?? null;
  const atrasado = ultimoSyncExitoso === null || ahora() - Date.parse(ultimoSyncExitoso) > maxEdadSyncMs;
  if (atrasado) log(`::warning::El sync diario no terminó bien en las últimas ${maxEdadSyncMs / 3_600_000} h (último: ${ultimoSyncExitoso ?? "nunca"})`);

  return { reactivados, ultimoSyncExitoso, atrasado };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resultado = await mantenerVivos({ repo: process.env.GITHUB_REPOSITORY });
  console.log(JSON.stringify(resultado));
  if (resultado.reactivados.length > 0 || resultado.atrasado) process.exitCode = 1;
}
