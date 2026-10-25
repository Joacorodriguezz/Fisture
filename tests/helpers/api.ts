import type { APIRoute } from "astro";
import type { User } from "../../drizzle/schema";
import { apiCtx } from "./ctx";

// Invoca un handler con un contexto mínimo y la D1 de prueba (el usuario se inyecta como si ya
// hubiera pasado el middleware de sesión).
export async function callApi(
  handler: APIRoute,
  DB: D1Database,
  options: { user?: User; method?: string; path?: string; body?: unknown; rawBody?: string; params?: Record<string, string> } = {}
) {
  return handler(
    apiCtx({
      url: new URL(options.path ?? "/api/test", "http://localhost").toString(),
      method: options.method,
      // apiCtx envía un string tal cual: se serializa acá para distinguir "JSON válido" de rawBody inválido
      body: options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body)),
      params: options.params,
      user: options.user as { id: string } | undefined,
      env: { DB, ENVIRONMENT: "test" },
    })
  );
}
