import { RETENCION_MS } from "./policies";

// Borra las ventanas de más de 24 h. Lo invoca el sync diario (runSync). Devuelve las filas borradas.
export async function limpiarRateLimits(DB: D1Database, now: number = Date.now()): Promise<number> {
  const res = await DB.prepare("DELETE FROM rate_limits WHERE window_start < ?1").bind(now - RETENCION_MS).run();
  return Number(res.meta?.changes ?? 0);
}
