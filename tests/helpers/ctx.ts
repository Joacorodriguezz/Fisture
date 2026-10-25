// Contexto mínimo de Astro (APIContext) para invocar handlers en los tests.
export interface ApiCtxOpts {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown; // se serializa como JSON; un string se envía tal cual (para probar JSON inválido)
  params?: Record<string, string>;
  user?: { id: string } | null;
  env?: unknown;
  over?: Record<string, unknown>;
}

export function apiCtx(opts: ApiCtxOpts = {}) {
  const url = new URL(opts.url ?? "https://fisture.test/api/partidos?limit=5");
  const body = opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
  const locals: Record<string, any> = { runtime: { env: opts.env ?? { ENVIRONMENT: "production" } } };
  if (opts.user) locals.user = opts.user;
  return {
    request: new Request(url, {
      method: opts.method ?? "GET",
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...opts.headers },
      body,
    }),
    url,
    params: opts.params ?? {},
    locals,
    ...opts.over,
  } as any;
}

// withApi loguea cada request por console.*: se silencia para no ensuciar la salida
export function silenciarConsola(vi: typeof import("vitest").vi) {
  for (const metodo of ["log", "warn", "error"] as const) vi.spyOn(console, metodo).mockImplementation(() => {});
}

// KV en memoria con la parte de la API que usa la app
export function kvEnMemoria() {
  const datos = new Map<string, string>();
  return {
    datos,
    get: async (k: string) => datos.get(k) ?? null,
    put: async (k: string, v: string) => void datos.set(k, v),
    delete: async (k: string) => void datos.delete(k),
  };
}
