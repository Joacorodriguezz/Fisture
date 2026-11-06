// Reglas de acceso: toda la web de lectura es pública; solo se pide sesión para lo personal.

// Páginas que sí requieren sesión (el resto se navega sin cuenta)
const PAGINAS_PROTEGIDAS = ["/configuracion"];

// APIs que no requieren sesión de usuario (tienen su propia autenticación o son de lectura pública)
const APIS_PUBLICAS = ["/api/auth", "/api/admin", "/api/health", "/api/equipos/buscar"];

function coincide(pathname: string, prefijos: string[]): boolean {
  return prefijos.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

export type Acceso = "permitir" | "login" | "no_autorizado";

// Decide qué hacer con una request según la ruta y si hay usuario con sesión válida
export function decidirAcceso(pathname: string, hayUsuario: boolean): Acceso {
  if (hayUsuario) return "permitir";
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    return coincide(pathname, APIS_PUBLICAS) ? "permitir" : "no_autorizado";
  }
  return coincide(pathname, PAGINAS_PROTEGIDAS) ? "login" : "permitir";
}

// Defensa CSRF de las requests que mutan estado (docs/16 D6). Es la única implementación: la aplica
// withApi a todo POST/PUT/PATCH/DELETE (salvo las rutas con origin "none").
// 1. Sec-Fetch-Site same-origin o none (acción directa del usuario): pasa.
// 2. Sec-Fetch-Site cross-site/same-site, o un Origin presente: el Origin debe ser el de la app
//    (PUBLIC_APP_URL) o estar en ALLOWED_ORIGINS.
// 3. Sin ninguna de las dos cabeceras: pasa solo si no hay cookie de sesión (curl, cron con Bearer, tests).
//    CSRF aplica a credenciales ambientales (cookies), no a Bearer.
export interface EnvOrigen {
  PUBLIC_APP_URL?: string;
  // Orígenes extra separados por comas (alias de Pages, www.). Vacío por defecto
  ALLOWED_ORIGINS?: string;
}

function origenesPermitidos(env: EnvOrigen): Set<string> {
  const out = new Set<string>();
  for (const valor of [env.PUBLIC_APP_URL ?? "", ...(env.ALLOWED_ORIGINS ?? "").split(",")]) {
    if (!valor.trim()) continue;
    try {
      out.add(new URL(valor.trim()).origin);
    } catch {
      // valor inválido: no habilita nada (falla cerrada)
    }
  }
  return out;
}

const COOKIE_DE_SESION = /(?:^|;\s*)session=/;

export function esMismoOrigen(request: Request, env: EnvOrigen): boolean {
  const origin = request.headers.get("Origin");
  const sfs = request.headers.get("Sec-Fetch-Site");
  if (sfs === "same-origin" || sfs === "none") return true;
  if (sfs || origin !== null) return origin !== null && origenesPermitidos(env).has(origin);
  return !COOKIE_DE_SESION.test(request.headers.get("Cookie") ?? "");
}

// Las mutaciones con cuerpo deben ser JSON: un "simple request" cross-origin (text/plain, formulario)
// llega sin preflight. Sin cuerpo y sin Content-Type (logout, DELETE sin datos) pasa.
export function contentTypeValido(request: Request): boolean {
  const tipo = request.headers.get("Content-Type");
  if (!tipo) {
    // Sin Content-Type hay cuerpo si Content-Length es mayor que 0 o, sin esa cabecera (chunked), si el
    // Request trae un stream: no se confía solo en Content-Length
    const largo = request.headers.get("Content-Length");
    if (largo !== null) return largo.trim() === "0";
    return request.body === null;
  }
  return /^application\/json\s*(;|$)/i.test(tipo.trim());
}

const MAX_NEXT = 512;

// Valida el destino post-login: solo rutas relativas internas (evita open redirect).
// Devuelve la ruta normalizada (path + query) o null si no es segura.
export function safeNext(raw: string | null | undefined): string | null {
  if (!raw || raw.length > MAX_NEXT) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  // Backslashes y caracteres de control: algunos navegadores los tratan como "/"
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw, "http://interno.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "http://interno.invalid") return null;
  // No volver a las pantallas de login ni a endpoints de API
  if (/^\/(login|api)(\/|$)/.test(url.pathname)) return null;
  return url.pathname + url.search;
}

// URL de login que recuerda a dónde volver (si el destino es seguro)
export function loginHref(next?: string | null): string {
  const destino = safeNext(next);
  return destino ? `/login?next=${encodeURIComponent(destino)}` : "/login";
}
