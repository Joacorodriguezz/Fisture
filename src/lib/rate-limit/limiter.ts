// Contador de ventana fija en D1 (docs/16 D1/D2). Una sola sentencia atómica por hit: el conteo es
// exacto y global. Pasado limit x CAP_FACTOR la sentencia no actualiza (WHERE) y por lo tanto no escribe.
import { CAP_FACTOR } from "./policies";

export interface Regla {
  limit: number;
  windowSec: number;
}

export interface HitResult {
  allowed: boolean;
  count: number;
  limit: number;
  retryAfter: number;
  windowStart: number;
}

export function ventana(now: number, windowSec: number): { windowStart: number; retryAfter: number } {
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  return { windowStart, retryAfter: Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000)) };
}

const UPSERT = `INSERT INTO rate_limits (bucket, subject, window_start, count) VALUES (?1, ?2, ?3, 1)
ON CONFLICT (bucket, subject, window_start) DO UPDATE SET count = count + 1 WHERE count < ?4
RETURNING count`;

export async function hit(DB: D1Database, bucket: string, subject: string, regla: Regla, now: number = Date.now()): Promise<HitResult> {
  const { windowStart, retryAfter } = ventana(now, regla.windowSec);
  const tope = regla.limit * CAP_FACTOR;
  const fila = await DB.prepare(UPSERT).bind(bucket, subject, windowStart, tope).first<{ count: number }>();
  // Sin fila devuelta: el contador ya estaba en el tope y no se tocó
  const count = fila ? Number(fila.count) : tope + 1;
  return { allowed: count <= regla.limit, count, limit: regla.limit, retryAfter, windowStart };
}

// Lee el contador de la ventana actual sin escribir
export async function peek(DB: D1Database, bucket: string, subject: string, windowSec: number, now: number = Date.now()): Promise<number> {
  const { windowStart } = ventana(now, windowSec);
  const fila = await DB.prepare("SELECT count FROM rate_limits WHERE bucket = ?1 AND subject = ?2 AND window_start = ?3")
    .bind(bucket, subject, windowStart)
    .first<{ count: number }>();
  return fila ? Number(fila.count) : 0;
}
