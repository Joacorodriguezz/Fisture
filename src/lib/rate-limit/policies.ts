// Políticas de límite de tasa: una sola fuente de verdad (docs/16 §5.3).
export type Scope = "ip" | "user";

export interface Policy {
  limit: number;
  windowSec: number;
  scope: Scope;
  // "memory": contador del isolate, sin escribir en D1 (solo lecturas públicas baratas, docs/16 D4)
  store?: "d1" | "memory";
}

export const POLICIES = {
  login: { limit: 10, windowSec: 600, scope: "ip" },
  oauth_callback: { limit: 20, windowSec: 600, scope: "ip" },
  calendar_sync: { limit: 10, windowSec: 60, scope: "user" },
  calendar_sync_hour: { limit: 60, windowSec: 3600, scope: "user" },
  calendar_sync_ip: { limit: 30, windowSec: 60, scope: "ip" },
  calendar_delete: { limit: 30, windowSec: 60, scope: "user" },
  mutation: { limit: 60, windowSec: 60, scope: "user" },
  mutation_ip: { limit: 120, windowSec: 60, scope: "ip" },
  admin_fail: { limit: 5, windowSec: 900, scope: "ip" },
  search_public: { limit: 60, windowSec: 60, scope: "ip", store: "memory" },
} as const satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;

// Pasado limit x CAP_FACTOR en la misma ventana ya no se escribe más (docs/16 D2)
export const CAP_FACTOR = 5;

// Retención de las filas de rate_limits
export const RETENCION_MS = 24 * 60 * 60 * 1000;

export const METODOS_QUE_MUTAN = ["POST", "PUT", "PATCH", "DELETE"] as const;

export function muta(method: string): boolean {
  return (METODOS_QUE_MUTAN as readonly string[]).includes(method.toUpperCase());
}

// Falla segura: una mutación sin política explícita cae en el límite genérico; una lectura en ninguno
export function politicasPorDefecto(method: string): PolicyName[] {
  return muta(method) ? ["mutation_ip", "mutation"] : [];
}
