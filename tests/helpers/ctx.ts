// Contexto mínimo de Astro (APIContext) para invocar handlers en los tests.
export function apiCtx(opts: { url?: string; headers?: Record<string, string>; env?: unknown; over?: Record<string, unknown> } = {}) {
  const url = new URL(opts.url ?? "https://fisture.test/api/partidos?limit=5");
  return {
    request: new Request(url, { method: "GET", headers: opts.headers ?? {} }),
    url,
    locals: { runtime: { env: opts.env ?? { ENVIRONMENT: "production" } } } as Record<string, any>,
    ...opts.over,
  } as any;
}
