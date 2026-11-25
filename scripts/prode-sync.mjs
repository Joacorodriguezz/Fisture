// Pasada del prode tras el final (docs/40 D4): llama a POST /api/admin/prode/sync. El endpoint decide si hay
// partidos pendientes. Deja `trabajo` (true, false o desconocido) como salida del paso y sale con 1 si la
// corrida falló. Lo usa .github/workflows/prode-sync.yml.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const esperarReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function correrPasada({
  appUrl,
  adminSecret,
  fetchImpl = fetch,
  esperar = esperarReal,
  log = console.log,
  reintentos = 2,
  pausaReintentoMs = 15_000,
  timeoutMs = 120_000,
} = {}) {
  if (!appUrl) throw new Error("Falta appUrl");
  if (!adminSecret) throw new Error("Falta adminSecret");
  const url = `${appUrl.replace(/\/+$/, "")}/api/admin/prode/sync`;

  // Errores de red y 5xx sin respuesta del endpoint se reintentan. Una corrida con trabajo que falló no: la
  // pasada sigue pendiente y la toma la corrida siguiente.
  let ultimo = "";
  for (let intento = 0; intento <= reintentos; intento++) {
    try {
      const respuesta = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminSecret}` },
        body: "{}",
        signal: AbortSignal.timeout(timeoutMs),
      });
      // El schedule corre desde la rama por defecto: hasta el release, producción no tiene la ruta
      if (respuesta.status === 404) {
        log("::warning::POST /api/admin/prode/sync respondió 404: la ruta todavía no está desplegada");
        return { trabajo: false };
      }
      const texto = await respuesta.text();
      if (respuesta.status === 401 || respuesta.status === 429) {
        ultimo = `HTTP ${respuesta.status}`;
        break;
      }
      let datos;
      try {
        datos = JSON.parse(texto);
      } catch {
        datos = undefined;
      }
      if (respuesta.ok && datos?.trabajo === false) {
        log("Sin pasadas pendientes");
        return { trabajo: false };
      }
      if (datos?.trabajo === true) {
        log(JSON.stringify(datos));
        if (datos.status === "success") return { trabajo: true };
        return { trabajo: true, error: `Run ${datos.status}: ${datos.error ?? "sin detalle"}` };
      }
      ultimo = `HTTP ${respuesta.status}: ${texto.slice(0, 300)}`;
    } catch (error) {
      ultimo = error instanceof Error ? error.message : String(error);
    }
    if (intento < reintentos) await esperar(pausaReintentoMs);
  }
  return { trabajo: null, error: `No se pudo correr la pasada: ${ultimo}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { trabajo, error } = await correrPasada({ appUrl: process.env.APP_URL, adminSecret: process.env.ADMIN_SECRET });
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `trabajo=${trabajo ?? "desconocido"}\n`);
  if (error) {
    const linea = error.replace(/[\r\n]+/g, " ");
    console.log(`::error::${linea}`);
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `PRODE_SYNC_ERROR=${linea}\n`);
    process.exitCode = 1;
  }
}
