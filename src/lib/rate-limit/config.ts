// Interruptor del límite de tasa que se cambia en caliente (docs/16 §12 y docs/23).
// Un secret de Pages solo toma efecto en el siguiente deploy, así que no sirve para apagar el limitador en un
// incidente. La fuente "en caliente" es la clave KV `ratelimit:modo` (leer KV no consume escrituras de D1 y
// sigue disponible si D1 está agotada). Valores: "off" (apaga), "observe" (cuenta y loguea sin bloquear),
// "on" (bloquea, aunque el secret diga otra cosa). Sin clave, manda el secret de arranque
// (RATE_LIMIT_DISABLED / RATE_LIMIT_MODE). El valor se cachea en el isolate para no sumar una subrequest por request.

export const CLAVE_MODO = "ratelimit:modo";
export const TTL_CONFIG_MS = 45_000;
// Si KV falla, el último valor conocido se usa como mucho este tiempo desde la última lectura buena;
// después manda el secret de arranque (así un "off" no queda pegado indefinidamente).
export const VIGENCIA_MAX_SIN_KV_MS = 10 * 60_000;

export interface EnvModo {
  KV?: Pick<KVNamespace, "get">;
  RATE_LIMIT_DISABLED?: string;
  RATE_LIMIT_MODE?: string;
}

export interface Modo {
  disabled: boolean;
  observe: boolean;
}

let cache: { valor: string | null; vence: number; leido: number } | null = null;

export function reiniciarConfig(): void {
  cache = null;
}

async function valorKv(kv: Pick<KVNamespace, "get">, now: number): Promise<string | null> {
  if (cache && cache.vence > now) return cache.valor;
  try {
    const valor = (await kv.get(CLAVE_MODO))?.trim().toLowerCase() || null;
    cache = { valor, vence: now + TTL_CONFIG_MS, leido: now };
    return valor;
  } catch {
    // KV caído: se conserva el último valor conocido y se reintenta pasado el TTL, pero solo hasta
    // VIGENCIA_MAX_SIN_KV_MS desde la última lectura buena; después manda el secret de arranque
    if (cache && now - cache.leido < VIGENCIA_MAX_SIN_KV_MS) {
      cache = { ...cache, vence: now + TTL_CONFIG_MS };
      return cache.valor;
    }
    return null;
  }
}

export async function modoLimite(env: EnvModo, now: number = Date.now()): Promise<Modo> {
  const kv = env.KV ? await valorKv(env.KV, now) : null;
  if (kv === "off") return { disabled: true, observe: false };
  if (kv === "observe") return { disabled: false, observe: true };
  if (kv === "on") return { disabled: false, observe: false };
  return { disabled: env.RATE_LIMIT_DISABLED === "true", observe: env.RATE_LIMIT_MODE === "observe" };
}
