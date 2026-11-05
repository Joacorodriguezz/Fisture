// Autorización de los endpoints /api/admin/*: Authorization: Bearer <ADMIN_SECRET>
import { modoLimite } from "../rate-limit/config";
import { hit } from "../rate-limit/limiter";
import { POLICIES } from "../rate-limit/policies";
import { sujetoIp } from "../rate-limit/subject";
import type { Logger } from "./logger";
import { respuesta429 } from "./with-api";

function iguales(a: string, b: string): boolean {
  // Comparación en tiempo constante respecto del contenido
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export function isAdminAuthorized(request: Request, adminSecret?: string): boolean {
  if (!adminSecret) return false;
  const header = request.headers.get("Authorization") ?? "";
  return iguales(header, `Bearer ${adminSecret}`);
}

export function unauthorized(): Response {
  return Response.json({ error: "Unauthorized" }, { status: 401 });
}

export interface AdminEnv {
  ADMIN_SECRET?: string;
  DB?: D1Database;
  KV?: Pick<KVNamespace, "get">;
  RATE_LIMIT_SALT?: string;
  RATE_LIMIT_DISABLED?: string;
  RATE_LIMIT_MODE?: string;
}

// Autoriza una request de /api/admin/* y cuenta solo los FALLOS por IP (docs/16 D5): 5 cada 15 minutos.
// Un Bearer válido pasa siempre: no cuenta, no escribe y nunca recibe 429 (un atacante no obtiene ninguna
// señal nueva y el cron no se bloquea por culpa de terceros). Con un Bearer inválido la decisión es atómica:
// primero hit() y después se elige 429 o 401 según el valor devuelto (sin peek() previo, que dejaría pasar
// requests concurrentes de más). Fail-open si D1 falla. Devuelve null si está autorizada.
export async function verificarAdmin(
  request: Request,
  env: AdminEnv,
  opts: { logger?: Logger; requestId?: string } = {}
): Promise<Response | null> {
  if (isAdminAuthorized(request, env.ADMIN_SECRET)) return null;
  if (env.DB && !(await modoLimite(env)).disabled) {
    const politica = POLICIES.admin_fail;
    try {
      const sujeto = await sujetoIp(request, env);
      if (sujeto) {
        const r = await hit(env.DB, "admin_fail", sujeto, politica);
        if (!r.allowed) {
          const campos = { bucket: "admin_fail", scope: "ip", limit: politica.limit, retryAfter: r.retryAfter };
          if ((await modoLimite(env)).observe) opts.logger?.warn("rate_limited", { ...campos, observe: true });
          else {
            // Solo el primer bloqueo de la ventana va en warn
            if (r.count === politica.limit + 1) opts.logger?.warn("rate_limited", campos);
            else opts.logger?.debug("rate_limited", campos);
            return respuesta429(r.retryAfter, opts.requestId ?? "");
          }
        }
      }
    } catch (err) {
      opts.logger?.error("rate_limit_unavailable", { bucket: "admin_fail", err });
    }
  }
  return unauthorized();
}
