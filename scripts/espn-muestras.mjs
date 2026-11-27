// Muestras de ESPN para el prode (docs/40 §8 paso 5). SOLO LECTURA: baja scoreboards y escribe JSON recortados
// en tests/fixtures/espn-prode-*.json; no toca D1 ni ninguna base. Mismo pedido que el adaptador
// (src/lib/data-providers/espn.ts): `{BASE}/{slug}/scoreboard?dates={año}&limit=1000`.
// Uso: node scripts/espn-muestras.mjs [--por-tipo 10] [--salida tests/fixtures]
// Sale con 0 aunque ESPN no devuelva datos de un slug (lo informa); con 1 solo si falla todo.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const BASE_URL = "https://site.api.espn.com/apis/site/v2/sports/soccer";
const SLUGS = ["arg.1", "arg.copa", "conmebol.libertadores", "conmebol.sudamericana"];
const PATRON_EXTRA = /shoot|pen|extra|aet|overtime|aggregate|leg|winner|advance/i;

const arg = (nombre, defecto) => {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : defecto;
};

async function pedir(url) {
  for (let intento = 0; intento < 3; intento++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json" } });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
    } catch {
      /* reintenta */
    }
    await new Promise((r) => setTimeout(r, 400 * (intento + 1)));
  }
  return null;
}

// Claves "sospechosas" (alargue/penales/global) a cualquier profundidad razonable, con su valor.
function camposExtra(obj, ruta = "", salida = {}, prof = 0) {
  if (!obj || typeof obj !== "object" || prof > 4) return salida;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "team" || k === "athletes" || k === "leaders" || k === "statistics" || k === "records") continue;
    const r = ruta ? `${ruta}.${k}` : k;
    if (PATRON_EXTRA.test(k) && !["linescores", "winner"].includes(k)) salida[r] = v;
    if (v && typeof v === "object" && !Array.isArray(v)) camposExtra(v, r, salida, prof + 1);
  }
  return salida;
}

export function terminado(ev) {
  const t = ev?.status?.type ?? ev?.competitions?.[0]?.status?.type;
  return t?.completed === true || t?.state === "post";
}

export function clasificar(ev) {
  const comp = ev.competitions?.[0] ?? {};
  const st = ev.status ?? comp.status ?? {};
  const nombre = st.type?.name ?? "";
  const detalle = `${st.type?.detail ?? ""} ${st.type?.description ?? ""} ${st.type?.shortDetail ?? ""}`;
  const tanda = (comp.competitors ?? []).some((c) => c.shootoutScore !== undefined) || /SHOOTOUT|PEN/i.test(nombre + detalle);
  if (tanda) return "penales";
  const [a, b] = comp.competitors ?? [];
  if (a && b && a.score === b.score && (a.winner || b.winner) && a.aggregateScore !== undefined) return "global";
  if (/EXTRA|AET|_ET/i.test(nombre) || /\bAET\b|extra/i.test(detalle) || (st.period ?? 0) >= 3) return "alargue";
  return "90";
}

export function recortar(ev, slug) {
  const comp = ev.competitions?.[0] ?? {};
  const st = ev.status ?? comp.status ?? {};
  return {
    liga: slug,
    id: ev.id,
    fecha: ev.date,
    nombre: ev.shortName ?? ev.name,
    temporada: ev.season ? { year: ev.season.year, slug: ev.season.slug, type: ev.season.type } : undefined,
    competicion: { type: comp.type, leg: comp.leg, series: comp.series, notes: comp.notes, headlines: comp.headlines },
    status: {
      type: st.type
        ? {
            name: st.type.name,
            state: st.type.state,
            completed: st.type.completed,
            description: st.type.description,
            detail: st.type.detail,
            shortDetail: st.type.shortDetail,
          }
        : undefined,
      period: st.period,
      displayClock: st.displayClock,
    },
    competitors: (comp.competitors ?? []).map((c) => ({
      homeAway: c.homeAway,
      team: c.team?.displayName,
      score: c.score,
      winner: c.winner,
      aggregateScore: c.aggregateScore,
      linescores: c.linescores,
      shootoutScore: c.shootoutScore,
      extra: camposExtra(c),
    })),
    extra: { ...camposExtra(ev), ...camposExtra(comp, "competition") },
  };
}

export async function main() {
  const porTipo = Number(arg("--por-tipo", "10"));
  const salida = arg("--salida", "tests/fixtures");
  const anioActual = new Date().getUTCFullYear();
  const anios = [anioActual - 3, anioActual - 2, anioActual - 1, anioActual];
  const grupos = { "90": [], alargue: [], penales: [], global: [] };
  const resumen = [];
  const estados = {};
  const noTerminados = {};
  let algunoRespondio = false;

  for (const slug of SLUGS) {
    for (const anio of anios) {
      const data = await pedir(`${BASE_URL}/${slug}/scoreboard?dates=${anio}&limit=1000`);
      const eventos = data?.events ?? [];
      if (eventos.length) algunoRespondio = true;
      const conteo = { "90": 0, alargue: 0, penales: 0, global: 0 };
      for (const ev of eventos) {
        const nombre = (ev.status ?? ev.competitions?.[0]?.status)?.type?.name ?? "?";
        if (!terminado(ev)) {
          if (!/SCHEDULED/.test(nombre)) (noTerminados[nombre] ??= []).push({ slug, anio, id: ev.id, nombre: ev.shortName });
          continue;
        }
        const tipo = clasificar(ev);
        conteo[tipo]++;
        const clave = `${tipo}:${nombre}`;
        estados[clave] = (estados[clave] ?? 0) + 1;
        if (grupos[tipo].length < porTipo * 4) grupos[tipo].push(recortar(ev, `${slug}/${anio}`));
      }
      resumen.push({ slug, anio, eventos: eventos.length, ...conteo, seasons: [...new Set(eventos.map((e) => e.season?.slug))] });
    }
  }

  // Reparte la muestra entre ligas para que no la copie una sola.
  const elegir = (lista) => {
    const porLiga = new Map();
    for (const e of lista) (porLiga.get(e.liga.split("/")[0]) ?? porLiga.set(e.liga.split("/")[0], []).get(e.liga.split("/")[0])).push(e);
    const out = [];
    for (let i = 0; out.length < porTipo; i++) {
      let hubo = false;
      for (const arr of porLiga.values()) if (arr[i] && out.length < porTipo) (out.push(arr[i]), (hubo = true));
      if (!hubo) break;
    }
    return out;
  };

  await mkdir(salida, { recursive: true });
  for (const [tipo, lista] of Object.entries(grupos)) {
    const archivo = join(salida, `espn-prode-${tipo === "90" ? "fin-90" : tipo === "global" ? "ida-vuelta" : tipo}.json`);
    await writeFile(archivo, JSON.stringify(elegir(lista), null, 2) + "\n");
    console.log(`${archivo}: ${Math.min(lista.length, porTipo)} de ${lista.length} candidatos`);
  }
  console.log(JSON.stringify({ resumen, estados, noTerminados }, null, 1));
  if (!algunoRespondio) {
    console.error("ESPN no devolvió eventos para ningún slug");
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
