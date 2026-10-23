// Envuelve un handler de src/pages/api/**: requestId, duración, log de request y captura de excepciones.
import type { APIRoute } from "astro";
import { createLogger, defaultLevel, type Logger } from "./logger";

export interface WithApiOptions {
  // Logger base (por defecto se crea uno según ENVIRONMENT). Útil para tests.
  logger?: Logger;
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

export function withApi(handler: APIRoute, options: WithApiOptions = {}): APIRoute {
  return async (context) => {
    const inicio = Date.now();
    const { request, url, locals } = context;
    const env = (locals as { runtime?: { env?: { ENVIRONMENT?: string } } }).runtime?.env;

    const requestId = request.headers.get("cf-ray") || crypto.randomUUID();
    const base =
      options.logger ?? createLogger({ level: defaultLevel(env?.ENVIRONMENT), env: env?.ENVIRONMENT });
    const route = (context as { routePattern?: string }).routePattern ?? url.pathname;
    const logger = base.child({ requestId, method: request.method, route, path: url.pathname });

    (locals as { requestId?: string; logger?: Logger }).requestId = requestId;
    (locals as { requestId?: string; logger?: Logger }).logger = logger;

    let response: Response;
    let error: unknown;
    try {
      response = await handler(context);
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
