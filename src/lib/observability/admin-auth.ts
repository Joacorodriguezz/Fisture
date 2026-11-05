// Autorización de los endpoints /api/admin/*: Authorization: Bearer <ADMIN_SECRET>
import { hit, peek, ventana } from "../rate-limit/limiter";
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
  RATE_LIMIT_SALT?: string;
  RATE_LIMIT_DISABLED?: string;
  RATE_LIMIT_MODE?: string;
}

// Autoriza una request de /api/admin/* y cuenta solo los FALLOS por IP (docs/16 D5): 5 cada 15 minutos.
// Agotado el límite se responde 429 aunque el Bearer sea correcto (así no se puede confirmar el secreto);
// los Bearer válidos no cuentan ni escriben. Fail-open si D1 falla. Devuelve null si está autorizada.
export async function verificarAdmin(
  request: Request,
  env: AdminEnv,
  opts: { logger?: Logger; requestId?: string } = {}
): Promise<Response | null> {
  const autorizado = isAdminAuthorized(request, env.ADMIN_SECRET);
  if (env.DB && env.RATE_LIMIT_DISABLED !== "true") {
    const politica = POLICIES.admin_fail;
    try {
      const sujeto = await sujetoIp(request, env);
      if (sujeto) {
        const fallos = await peek(env.DB, "admin_fail", sujeto, politica.windowSec);
        if (fallos >= politica.limit) {
          const { retryAfter } = ventana(Date.now(), politica.windowSec);
          const campos = { bucket: "admin_fail", scope: "ip", limit: politica.limit, retryAfter };
          if (env.RATE_LIMIT_MODE === "observe") opts.logger?.warn("rate_limited", { ...campos, observe: true });
          else {
            opts.logger?.warn("rate_limited", campos);
            return respuesta429(retryAfter, opts.requestId ?? "");
          }
        }
        if (!autorizado) await hit(env.DB, "admin_fail", sujeto, politica);
      }
    } catch (err) {
      opts.logger?.error("rate_limit_unavailable", { bucket: "admin_fail", err });
    }
  }
  return autorizado ? null : unauthorized();
}
