// Caché del HTML público anónimo (docs/35). Sin dependencias de Astro: la caché, waitUntil, el build id y el
// interruptor llegan inyectados. Nunca rompe una página: cualquier fallo de la caché sirve el render normal.

export interface CacheLike {
  match(request: Request | string): Promise<Response | undefined>;
  put(request: Request | string, response: Response): Promise<void>;
}

export interface PoliticaCache {
  /** Segundos de vida de la copia guardada (s-maxage) */
  ttl: number;
  /** Parámetros de query que no impiden cachear; cualquier otro saltea la caché */
  params: readonly string[];
}

export interface EntradaCache {
  request: Request;
  /** `caches.default`; undefined si el entorno no la tiene (p. ej. astro dev) */
  cache: CacheLike | undefined;
  waitUntil: (promesa: Promise<unknown>) => void;
  buildId: string;
  /** HTML_CACHE=off */
  apagado: boolean;
  onError?: (operacion: "match" | "put", error: unknown) => void;
}

const TTL_SEGUNDOS = 900;

// Una sola tabla por ruta: TTL y parámetros de query permitidos
const POLITICAS: { patron: RegExp; politica: PoliticaCache }[] = [
  { patron: /^\/equipos\/(?!buscar\/?$)[^/]+$/, politica: { ttl: TTL_SEGUNDOS, params: ["lado"] } },
  { patron: /^\/ligas\/[^/]+$/, politica: { ttl: TTL_SEGUNDOS, params: [] } },
  { patron: /^\/partidos\/[^/]+$/, politica: { ttl: TTL_SEGUNDOS, params: [] } },
];

export function politicaDe(pathname: string): PoliticaCache | null {
  return POLITICAS.find((p) => p.patron.test(pathname))?.politica ?? null;
}

/** La URL pedida más el build id: un deploy nuevo empieza con la caché vacía (D5) */
export function claveDeCache(url: URL, buildId: string): string {
  const clave = new URL(url.pathname + url.search, url.origin);
  clave.searchParams.set("__build", buildId);
  return clave.toString();
}

const tieneCookieSession = (request: Request) =>
  (request.headers.get("Cookie") ?? "").split(";").some((c) => c.trim().startsWith("session="));

function seCachea(res: Response): boolean {
  return res.status === 200 && !res.headers.has("Set-Cookie") && (res.headers.get("Content-Type") ?? "").toLowerCase().includes("text/html");
}

// La respuesta al cliente: que el navegador no guarde el HTML anónimo (D6)
function paraElCliente(res: Response, estado: "HIT" | "MISS"): Response {
  const salida = new Response(res.body, res);
  salida.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  salida.headers.set("x-fisture-cache", estado);
  return salida;
}

export async function servirConCache(entrada: EntradaCache, next: () => Promise<Response>): Promise<Response> {
  const { request, cache, waitUntil, buildId, apagado, onError } = entrada;
  const url = new URL(request.url);
  const politica = politicaDe(url.pathname);

  if (
    !cache ||
    apagado ||
    !politica ||
    request.method !== "GET" ||
    tieneCookieSession(request) ||
    [...url.searchParams.keys()].some((k) => !politica.params.includes(k))
  ) {
    return next();
  }

  const clave = claveDeCache(url, buildId);

  try {
    const guardada = await cache.match(clave);
    if (guardada) return paraElCliente(guardada, "HIT");
  } catch (error) {
    onError?.("match", error);
  }

  const res = await next();
  if (!seCachea(res)) return res;

  try {
    const copia = new Response(res.clone().body, { status: res.status, headers: res.headers });
    copia.headers.set("Cache-Control", `public, s-maxage=${politica.ttl}`);
    waitUntil(
      Promise.resolve()
        .then(() => cache.put(clave, copia))
        .catch((error) => onError?.("put", error))
    );
  } catch (error) {
    onError?.("put", error);
  }
  return paraElCliente(res, "MISS");
}
