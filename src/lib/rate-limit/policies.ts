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
  // Unirse a un grupo del prode: acota el barrido de códigos de invitación
  prode_unirse: { limit: 10, windowSec: 600, scope: "user" },
  prode_unirse_ip: { limit: 30, windowSec: 600, scope: "ip" },
  // Crear grupos del prode: 10 por hora por usuario (coincide con el tope de grupos por dueño) y 30 por IP
  prode_grupo_crear: { limit: 10, windowSec: 3600, scope: "user" },
  prode_grupo_crear_ip: { limit: 30, windowSec: 3600, scope: "ip" },
  // Lecturas autenticadas del prode (ranking general, de grupo y mis-puntos): las más caras de D1
  prode_lectura: { limit: 60, windowSec: 60, scope: "user" },
  search_public:{ limit: 60, windowSec: 60, scope: "ip", store: "memory" },
} as const satisfies Record<string, Policy>;

export type PolicyName = keyof typeof POLICIES;


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
