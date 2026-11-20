// Límite por IP del link de invitación (docs/37 D6). La página /prode/unirse/[código] es un GET público que
// confirma si un código existe: sin límite, se podrían probar códigos sin pasar por el POST de unirse
// (que ya limita prode_unirse_ip y prode_unirse). Las páginas no pasan por withApi, así que se aplica
// acá con el mismo interruptor (KV ratelimit:modo y secrets) y en memoria del isolate (docs/16 D4).
import { modoLimite, type EnvModo } from "../rate-limit/config";
import { hitMemory } from "../rate-limit/memory";
import { POLICIES } from "../rate-limit/policies";
import { ipDe, normalizarIp } from "../rate-limit/subject";

// null si puede seguir; si no, los segundos a esperar (Retry-After)
export async function limiteInvitacion(request: Request, env: EnvModo): Promise<number | null> {
  const modo = await modoLimite(env);
  if (modo.disabled) return null;
  const ip = ipDe(request);
  if (!ip) return null;
  const { limit, windowSec } = POLICIES.prode_invitacion_ip;
  const r = hitMemory(`prode_invitacion_ip:${normalizarIp(ip)}`, limit, windowSec);
  return r.allowed || modo.observe ? null : r.retryAfter;
}
