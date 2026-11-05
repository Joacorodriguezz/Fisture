// Limitador en memoria del isolate, solo "mejor esfuerzo" (docs/16 D4): cada isolate cuenta por su lado y
// se reinicia sin aviso. Se usa únicamente para lecturas públicas baratas, nunca para proteger escrituras.
interface Entrada {
  windowStart: number;
  count: number;
}

const MAX_ENTRADAS = 2000;
const contadores = new Map<string, Entrada>();

export function reiniciarMemoria(): void {
  contadores.clear();
}

export function hitMemory(key: string, limit: number, windowSec: number, now: number = Date.now()) {
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const retryAfter = Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));

  if (contadores.size >= MAX_ENTRADAS) {
    // Acota la memoria: descarta las ventanas vencidas y, si no alcanza, todo
    for (const [k, e] of contadores) if (e.windowStart < windowStart) contadores.delete(k);
    if (contadores.size >= MAX_ENTRADAS) contadores.clear();
  }

  const actual = contadores.get(key);
  const entrada = actual && actual.windowStart === windowStart ? actual : { windowStart, count: 0 };
  entrada.count++;
  contadores.set(key, entrada);
  return { allowed: entrada.count <= limit, count: entrada.count, limit, retryAfter, windowStart };
}
