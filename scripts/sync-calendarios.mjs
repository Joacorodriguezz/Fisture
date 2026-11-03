// Reconciliación de calendarios lote por lote contra POST /api/admin/sync (docs/17).
// Workers Free permite 50 subrequests por invocación, así que cada request atiende a unos pocos usuarios
// y responde `siguiente: true` mientras queden. El primer lote devuelve un `corte` que se reenvía en
// los demás: es un barrido, y cada usuario se atiende una sola vez por barrido.
// Lo usa .github/workflows/sync-cron.yml. Sale con 1 si un lote falla o no avanza; si se alcanza el
// máximo de lotes con usuarios pendientes sigue en el próximo sync (los menos atendidos van primero).
import { pathToFileURL } from "node:url";

const esperarReal = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sincronizarCalendarios({
  appUrl,
  adminSecret,
  fetchImpl = fetch,
  esperar = esperarReal,
  log = console.log,
  maxLotes = 40,
  // Workers Free tolera ráfagas de CPU, no lotes pesados seguidos (ver sync-por-lotes.sh)
  pausaMs = 15_000,
  reintentos = 2,
  pausaReintentoMs = 15_000,
  pausaTras1102Ms = 60_000,
  timeoutMs = 120_000,
} = {}) {
  if (!appUrl) throw new Error("Falta appUrl");
  if (!adminSecret) throw new Error("Falta adminSecret");
  const url = `${appUrl.replace(/\/+$/, "")}/api/admin/sync`;
  const resultado = { lotes: 0, usuarios: 0, eventosOk: 0, eventosFallidos: 0, sinAcceso: 0, completo: false };

  // Un lote, con reintentos ante errores de red o 5xx. Un 401 no se reintenta.
  async function pedir(corte) {
    let ultimo = "";
    for (let intento = 0; intento <= reintentos; intento++) {
      try {
        const respuesta = await fetchImpl(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminSecret}` },
          body: JSON.stringify(corte === undefined ? { calendarios: true } : { calendarios: true, corte }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const texto = await respuesta.text();
        if (respuesta.status === 401) return { fatal: "ADMIN_SECRET rechazado (401): se corta el sync de calendarios" };
        if (respuesta.ok) return { datos: JSON.parse(texto) };
        ultimo = `HTTP ${respuesta.status}: ${texto.slice(0, 300)}`;
        if (respuesta.status === 400) return { fatal: ultimo };
        // Un 500 con success false es un fallo del lote registrado en sync_runs: se informa tal cual
        try {
          const datos = JSON.parse(texto);
          if (datos?.success === false && datos.error) ultimo = `${datos.error}`;
        } catch {
          /* no era JSON */
        }
        if (intento < reintentos) await esperar(texto.includes("1102") ? pausaTras1102Ms : pausaReintentoMs);
      } catch (error) {
        ultimo = error instanceof Error ? error.message : String(error);
        if (intento < reintentos) await esperar(pausaReintentoMs);
      }
    }
    return { fatal: ultimo };
  }

  let corte;
  for (let lote = 0; lote < maxLotes; lote++) {
    const { datos, fatal } = await pedir(corte);
    if (fatal) {
      resultado.error = `Lote ${lote + 1} falló: ${fatal}`;
      log(`::error::${resultado.error}`);
      return resultado;
    }

    resultado.lotes++;
    resultado.usuarios += datos.usuarios;
    resultado.eventosOk += datos.eventosOk;
    resultado.eventosFallidos += datos.eventosFallidos;
    resultado.sinAcceso += datos.sinAcceso;
    corte = datos.corte;
    log(
      `Lote ${lote + 1}: ${datos.usuarios} usuarios, ${datos.eventosOk} eventos ok, ${datos.eventosFallidos} fallidos, ${datos.sinAcceso} sin acceso, ${datos.subrequests} subrequests${datos.siguiente ? "" : " (barrido completo)"}`
    );

    if (!datos.siguiente) {
      resultado.completo = true;
      return resultado;
    }
    if (datos.usuarios === 0) {
      resultado.error = `Lote ${lote + 1} sin progreso: no alcanzó el presupuesto para atender ni a un usuario (revisar docs/17)`;
      log(`::error::${resultado.error}`);
      return resultado;
    }
    await esperar(pausaMs);
  }

  log(`::warning::Barrido de calendarios incompleto tras ${maxLotes} lotes: sigue en el próximo sync (los menos atendidos primero)`);
  return resultado;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const resultado = await sincronizarCalendarios({ appUrl: process.env.APP_URL, adminSecret: process.env.ADMIN_SECRET });
  console.log(JSON.stringify(resultado));
  if (resultado.error) {
    if (process.env.GITHUB_ENV) {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(process.env.GITHUB_ENV, `CALENDARIOS_ERROR=${resultado.error.replace(/[\r\n]+/g, " ")}\n`);
    }
    process.exitCode = 1;
  }
}
