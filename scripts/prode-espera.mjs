// Alerta de espera del prode (docs/40 D5): consulta GET /api/admin/status y, si hay partidos terminados sin
// resultado que puntúe (metricas.prode.automatizacion.enEspera), abre un issue `incidente` con
// .github/scripts/incidente.sh; cuando vuelve a 0 lo cierra. Si no puede leer el dato sale con 1 sin tocar el
// issue. Lo usa .github/workflows/sync-cron.yml.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const TITULO = "Prode: resultados en espera";

const esperarReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const incidenteReal = (accion, titulo, detalle) =>
  execFileSync("bash", [".github/scripts/incidente.sh", accion, titulo, detalle], { stdio: "inherit" });

export async function avisarEspera({
  appUrl,
  adminSecret,
  fetchImpl = fetch,
  incidente = incidenteReal,
  esperar = esperarReal,
  log = console.log,
  runUrl = "",
  reintentos = 2,
  pausaReintentoMs = 15_000,
  timeoutMs = 60_000,
} = {}) {
  if (!appUrl) throw new Error("Falta appUrl");
  if (!adminSecret) throw new Error("Falta adminSecret");
  const url = `${appUrl.replace(/\/+$/, "")}/api/admin/status`;

  // Errores de red y 5xx se reintentan; un 401 o un 429 se repetirían
  async function pedir() {
    let ultimo = "";
    for (let intento = 0; intento <= reintentos; intento++) {
      try {
        const respuesta = await fetchImpl(url, { headers: { Authorization: `Bearer ${adminSecret}` }, signal: AbortSignal.timeout(timeoutMs) });
        if (respuesta.ok) return await respuesta.json();
        ultimo = `HTTP ${respuesta.status}`;
        if (respuesta.status === 401 || respuesta.status === 429) break;
      } catch (error) {
        ultimo = error instanceof Error ? error.message : String(error);
      }
      if (intento < reintentos) await esperar(pausaReintentoMs);
    }
    throw new Error(`No se pudo consultar /api/admin/status: ${ultimo}`);
  }

  const enEspera = (await pedir())?.metricas?.prode?.automatizacion?.enEspera;
  if (!Number.isInteger(enEspera)) throw new Error("/api/admin/status no trae metricas.prode.automatizacion.enEspera");
  log(`Partidos del prode en espera: ${enEspera}`);

  const run = runUrl ? ` Run: ${runUrl}.` : "";
  if (enEspera > 0) {
    // Lo consultan las pasadas del prode cada 15 minutos: se avisa al abrir, sin comentar cada vez
    await incidente(
      "abrir-una-vez",
      TITULO,
      `Partidos terminados sin resultado que puntúe: ${enEspera}. Verlos en GET /api/admin/prode/partidos (enEspera) y corregir o excluir según docs/38 §3.5.${run}`
    );
  } else {
    await incidente("cerrar", TITULO, `Ya no hay resultados en espera.${run}`);
  }
  return enEspera;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await avisarEspera({ appUrl: process.env.APP_URL, adminSecret: process.env.ADMIN_SECRET, runUrl: process.env.RUN_URL });
}
