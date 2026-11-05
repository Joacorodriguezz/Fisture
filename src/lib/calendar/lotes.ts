import { MAX_PARTIDOS_POR_REQUEST } from "./limites";

// Parte la lista de partidos en lotes que caben en una request de POST /api/calendario/sync (docs/16 §12 R2).
export function partirEnLotes<T>(items: readonly T[], tamano: number = MAX_PARTIDOS_POR_REQUEST): T[][] {
  const t = Math.max(1, Math.floor(tamano));
  const lotes: T[][] = [];
  for (let i = 0; i < items.length; i += t) lotes.push(items.slice(i, i + t));
  return lotes;
}

export interface ResultadoLotes {
  ok: number;
  fallo: number;
  // El servidor pidió frenar (429): quedan partidos sin intentar
  limitado: boolean;
  retryAfter: string | null;
  sinSesion: boolean;
}

interface Opciones {
  enviar: (matchIds: string[]) => Promise<Response>;
  onProgreso?: (hechos: number, total: number) => void;
  tamano?: number;
}

// Manda los lotes en secuencia, cada uno como una request aparte. Un 429 corta (con su Retry-After); un 401 corta
// para pedir login; cualquier otro error del lote cuenta sus partidos como fallidos y sigue con los demás.
export async function sincronizarEnLotes(matchIds: readonly string[], { enviar, onProgreso, tamano }: Opciones): Promise<ResultadoLotes> {
  const lotes = partirEnLotes(matchIds, tamano);
  const r: ResultadoLotes = { ok: 0, fallo: 0, limitado: false, retryAfter: null, sinSesion: false };
  let hechos = 0;
  for (const lote of lotes) {
    onProgreso?.(hechos, matchIds.length);
    let res: Response;
    try {
      res = await enviar(lote);
    } catch {
      r.fallo += lote.length;
      hechos += lote.length;
      continue;
    }
    if (res.status === 401) {
      r.sinSesion = true;
      return r;
    }
    if (res.status === 429) {
      r.limitado = true;
      r.retryAfter = res.headers.get("Retry-After");
      return r;
    }
    if (!res.ok && res.status !== 207) {
      r.fallo += lote.length;
    } else {
      const data = (await res.json().catch(() => ({}))) as { results?: { success: boolean }[] };
      const resultados = data.results ?? [];
      const ok = resultados.filter((x) => x.success).length;
      r.ok += ok;
      r.fallo += Math.max(resultados.length, lote.length) - ok;
    }
    hechos += lote.length;
  }
  return r;
}
