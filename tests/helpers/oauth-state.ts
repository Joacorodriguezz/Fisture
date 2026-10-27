// Cookies en memoria y atajos para probar el estado firmado del login OAuth.
import { vi } from "vitest";
import { crearEstado, nombreCookieEstado, type DatosEstadoOAuth } from "../../src/lib/auth/oauth-state";

export const OAUTH_STATE_SECRET = "secret-de-prueba-0123456789abcdef";

export interface OpcionesCookie {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
  maxAge?: number;
}

// Imita Astro.cookies: set / get / delete sobre un Map, con las llamadas espiables
export function cookiesEnMemoria(iniciales: Record<string, string> = {}) {
  const valores = new Map<string, string>(Object.entries(iniciales));
  const opciones = new Map<string, OpcionesCookie>();
  return {
    valores,
    opciones,
    get: (nombre: string) => (valores.has(nombre) ? { value: valores.get(nombre)! } : undefined),
    set: vi.fn((nombre: string, valor: string, o: OpcionesCookie = {}) => {
      valores.set(nombre, valor);
      opciones.set(nombre, o);
    }),
    delete: vi.fn((nombre: string) => void valores.delete(nombre)),
  };
}

// Lo que quedó dentro de la cookie de estado (el payload no es secreto, solo está firmado)
export function payloadDe(cookie: string): { state: string; codeVerifier: string; provider: string; next: string | null; exp: number } {
  const base64 = cookie.split(".")[0].replace(/-/g, "+").replace(/_/g, "/");
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))));
}

export async function cookieDeEstado(extra: Partial<DatosEstadoOAuth> = {}, ahora = Date.now()) {
  const datos: DatosEstadoOAuth = { state: "st-1", codeVerifier: "cv", provider: "google", next: null, ...extra };
  return { nombre: nombreCookieEstado(datos.provider), valor: await crearEstado(OAUTH_STATE_SECRET, datos, ahora) };
}
