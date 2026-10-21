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
