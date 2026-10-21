import type { APIContext, APIRoute } from "astro";
import type { User } from "../../drizzle/schema";

export async function callApi(handler: APIRoute, DB: D1Database, options: { user?: User; method?: string; path?: string; body?: unknown; params?: Record<string, string> } = {}) {
  const url = new URL(options.path ?? "/api/test", "http://localhost");
  const request = new Request(url, {
    method: options.method ?? "GET",
    ...(options.body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) } : {}),
  });
  return handler({ request, url, locals: { runtime: { env: { DB, ENVIRONMENT: "test" } }, user: options.user }, params: options.params ?? {} } as APIContext);
}
