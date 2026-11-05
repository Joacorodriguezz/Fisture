// Envuelve un handler de src/pages/api/**: requestId, duración, log de request y captura de excepciones.
// También es el único punto de aplicación de la verificación de origen y del límite de tasa (docs/16):
// orden origen y Content-Type (sin I/O) -> límite por IP -> límite por usuario -> handler.
import type { APIRoute } from "astro";
import { contentTypeValido, esMismoOrigen } from "../auth/guards";
import { hit, type HitResult } from "../rate-limit/limiter";
import { hitMemory } from "../rate-limit/memory";
import { muta, POLICIES, politicasPorDefecto, type PolicyName } from "../rate-limit/policies";
import { sujetoIp } from "../rate-limit/subject";
import { createLogger, defaultLevel, type Logger } from "./logger";

export interface WithApiOptions {
  // Logger base (por defecto se crea uno según ENVIRONMENT). Útil para tests.
  logger?: Logger;
  // Políticas de límite de la ruta (lib/rate-limit/policies.ts). Sin esto, las mutaciones usan
  // mutation_ip + mutation y las lecturas no se limitan. [] desactiva el límite de la ruta.
  rateLimit?: PolicyName[];
  // "session" (por defecto): las mutaciones verifican origen. "none": rutas con Bearer (admin), sin CSRF.
  origin?: "session" | "none";
  // "json" (por defecto): las mutaciones con cuerpo deben ser application/json. "any": sin chequeo.
  contentType?: "json" | "any";
}

interface EnvLimites {
  ENVIRONMENT?: string;
  DB?: D1Database;
  PUBLIC_APP_URL?: string;
  ALLOWED_ORIGINS?: string;
  ADMIN_SECRET?: string;
  RATE_LIMIT_SALT?: string;
  RATE_LIMIT_DISABLED?: string;
  RATE_LIMIT_MODE?: string;
}

function agregarHeader(res: Response, nombre: string, valor: string): Response {
  try {
    res.headers.set(nombre, valor);
    return res;
  } catch {
    // Headers inmutables (p. ej. Response.redirect): se reconstruye la respuesta
    const headers = new Headers(res.headers);
    headers.set(nombre, valor);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  }
}

export function respuesta429(retryAfter: number, requestId: string): Response {
  return Response.json(
    { error: "rate_limited", retryAfter, requestId },
    { status: 429, headers: { "Retry-After": String(retryAfter), "Cache-Control": "no-store" } }
  );
}

// Devuelve la respuesta de rechazo (403/415/429) o null si la request puede seguir al handler
async function aplicarGuardas(
  context: Parameters<APIRoute>[0],
  env: EnvLimites,
  options: WithApiOptions,
  logger: Logger,
  requestId: string
): Promise<Response | null> {
  const { request, locals } = context;
  const method = request.method.toUpperCase();
  const mutacion = muta(method);

  if (mutacion && options.origin !== "none" && !esMismoOrigen(request, env)) {
    // Sin Origin, cookies ni IP en el log (docs/16 OR15)
    logger.warn("origin_rejected");
    return Response.json({ error: "forbidden_origin", requestId }, { status: 403 });
  }
  if (mutacion && options.contentType !== "any" && !contentTypeValido(request)) {
    return Response.json({ error: "unsupported_media_type", requestId }, { status: 415 });
  }

  if (env.RATE_LIMIT_DISABLED === "true") return null;
  const reglas = (options.rateLimit ?? politicasPorDefecto(method)).map((nombre) => ({ nombre, ...POLICIES[nombre] }));
  if (reglas.length === 0) return null;

  const observe = env.RATE_LIMIT_MODE === "observe";
  const userId = (locals as { user?: { id: string } }).user?.id;
  let ipSujeto: string | null | undefined;
  let ipCrudo: string | null = null;

  // IP primero: si ya bloqueó, no se evalúa (ni se escribe) el de usuario
  for (const scope of ["ip", "user"] as const) {
    for (const regla of reglas.filter((r) => r.scope === scope)) {
      let r: HitResult | null = null;
      try {
        const memoria = (regla as { store?: string }).store === "memory";
        if (scope === "user") {
          if (!userId || !env.DB) continue;
          r = await hit(env.DB, regla.nombre, userId, regla);
        } else if (memoria) {
          ipCrudo ??= request.headers.get("cf-connecting-ip")?.trim() || null;
          if (!ipCrudo) continue;
          r = hitMemory(`${regla.nombre}:${ipCrudo}`, regla.limit, regla.windowSec);
        } else {
          if (!env.DB) continue;
          if (ipSujeto === undefined) ipSujeto = await sujetoIp(request, env);
          if (!ipSujeto) {
            logger.debug("rate_limit_ip_omitida");
            continue;
          }
          r = await hit(env.DB, regla.nombre, ipSujeto, regla);
        }
      } catch (err) {
        // Fail-open: un incidente de D1 no debe tumbar la app por el limitador (docs/16 D2)
        logger.error("rate_limit_unavailable", { bucket: regla.nombre, err });
        return null;
      }
      if (r.allowed) continue;

      const campos = { bucket: regla.nombre, scope, limit: regla.limit, retryAfter: r.retryAfter, ...(observe ? { observe: true } : {}) };
      // Solo el primer bloqueo de la ventana va en warn: no se inunda el log durante un ataque
      if (r.count === regla.limit + 1) logger.warn("rate_limited", campos);
      else logger.debug("rate_limited", campos);
      if (!observe) return respuesta429(r.retryAfter, requestId);
    }
  }
  return null;
}

export function withApi(handler: APIRoute, options: WithApiOptions = {}): APIRoute {
  return async (context) => {
    const inicio = Date.now();
    const { request, url, locals } = context;
    const env = ((locals as { runtime?: { env?: EnvLimites } }).runtime?.env ?? {}) as EnvLimites;

    const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
    const base =
      options.logger ?? createLogger({ level: defaultLevel(env.ENVIRONMENT), env: env.ENVIRONMENT });
    const route = (context as { routePattern?: string }).routePattern ?? url.pathname;
    const logger = base.child({ requestId, method: request.method, route, path: url.pathname });

    (locals as { requestId?: string; logger?: Logger }).requestId = requestId;
    (locals as { requestId?: string; logger?: Logger }).logger = logger;

    let response: Response;
    let error: unknown;
    try {
      response = (await aplicarGuardas(context, env, options, logger, requestId)) ?? (await handler(context));
    } catch (err) {
      error = err;
      response = Response.json({ error: "Internal error", requestId }, { status: 500 });
    }

    const status = response.status;
    const { user, omitirUserIdEnLog } = locals as { user?: { id: string }; omitirUserIdEnLog?: boolean };
    const userId = omitirUserIdEnLog ? undefined : user?.id;
    const fields = { status, durationMs: Date.now() - inicio, ...(userId ? { userId } : {}), ...(error ? { err: error } : {}) };

    if (status >= 500) logger.error("request", fields);
    else if (status >= 400) logger.warn("request", fields);
    else logger.info("request", fields);

    return agregarHeader(response, "x-request-id", requestId);
  };
}
