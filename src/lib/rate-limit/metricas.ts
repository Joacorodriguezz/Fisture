// Métricas del límite de tasa para /api/admin/status (docs/16 §8). Se derivan del propio contador:
// los bloqueos son los hits por encima del límite, no hace falta una tabla aparte ni escrituras extra.
// Nunca se exponen los sujetos (ids de usuario o hashes de IP), solo cantidades.
import { POLICIES, RETENCION_MS } from "./policies";

export interface MetricaBucket {
  bucket: string;
  limit: number;
  // Requests contadas en las últimas 24 h (cada una escribió o intentó escribir una fila)
  hits: number;
  // Hits por encima del límite (tras el tope limit x 5 ya no se cuentan)
  blocked: number;
  subjects: number;
}

export interface MetricasRateLimit {
  filas: number;
  ultimas24h: MetricaBucket[];
}

export async function metricasRateLimit(DB: D1Database, now: number = Date.now()): Promise<MetricasRateLimit> {
  const desde = now - RETENCION_MS;
  const nombres = Object.keys(POLICIES).filter((n) => (POLICIES as Record<string, { store?: string }>)[n].store !== "memory");
  const casos = nombres.map((_, i) => `WHEN ?${i + 2} THEN MAX(count - ?${nombres.length + i + 2}, 0)`).join(" ");
  const sql = `SELECT bucket, SUM(count) AS hits, COUNT(DISTINCT subject) AS subjects,
    SUM(CASE bucket ${casos} ELSE 0 END) AS blocked
    FROM rate_limits WHERE window_start >= ?1 GROUP BY bucket ORDER BY bucket`;
  const limites = nombres.map((n) => (POLICIES as Record<string, { limit: number }>)[n].limit);
  const { results } = await DB.prepare(sql)
    .bind(desde, ...nombres, ...limites)
    .all<{ bucket: string; hits: number; subjects: number; blocked: number }>();

  const total = await DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>();
  return {
    filas: Number(total?.n ?? 0),
    ultimas24h: results.map((r) => ({
      bucket: r.bucket,
      limit: (POLICIES as Record<string, { limit: number }>)[r.bucket]?.limit ?? 0,
      hits: Number(r.hits),
      blocked: Number(r.blocked),
      subjects: Number(r.subjects),
    })),
  };
}

