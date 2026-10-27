// Estado del intento de login OAuth, guardado en una cookie firmada (HMAC-SHA256) en lugar de KV.
// Se firma para que no se pueda alterar; no se cifra: el code_verifier queda en una cookie HttpOnly
// del propio navegador (docs/20-login-sin-kv-tdd.md, D1 y D4).

export const OAUTH_STATE_TTL_SEGUNDOS = 600;

export interface DatosEstadoOAuth {
  state: string;
  codeVerifier: string;
  provider: string;
  next: string | null;
}

interface Payload extends DatosEstadoOAuth {
  exp: number; // ms Unix
}

// Una cookie por proveedor: dos intentos en paralelo (Google y Microsoft) no se pisan
export function nombreCookieEstado(provider: string): string {
  return `oauth_state_${provider}`;
}

const encoder = new TextEncoder();

function aBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function deBase64Url(texto: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(texto)) return null;
  try {
    const binary = atob(texto.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function claveHmac(secret: string, usos: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usos);
}

export async function crearEstado(secret: string, datos: DatosEstadoOAuth, ahora = Date.now()): Promise<string> {
  const payload: Payload = { ...datos, exp: ahora + OAUTH_STATE_TTL_SEGUNDOS * 1000 };
  const cuerpo = aBase64Url(encoder.encode(JSON.stringify(payload)));
  const firma = await crypto.subtle.sign("HMAC", await claveHmac(secret, ["sign"]), encoder.encode(cuerpo));
  return `${cuerpo}.${aBase64Url(new Uint8Array(firma))}`;
}

// Devuelve lo que el callback necesita, o null si la cookie falta, está alterada, venció o no
// corresponde al state / proveedor de esta request. Nunca lanza.
export async function leerEstado(
  secret: string,
  cookie: string | undefined,
  esperado: { state: string; provider: string },
  ahora = Date.now()
): Promise<{ codeVerifier: string; next: string | null } | null> {
  if (!cookie) return null;
  const partes = cookie.split(".");
  if (partes.length !== 2) return null;
  const [cuerpo, firmaTexto] = partes;

  const firma = deBase64Url(firmaTexto);
  if (!firma) return null;

  // verify compara en tiempo constante
  const valida = await crypto.subtle.verify("HMAC", await claveHmac(secret, ["verify"]), new Uint8Array(firma), encoder.encode(cuerpo));
  if (!valida) return null;

  const bytes = deBase64Url(cuerpo);
  if (!bytes) return null;
  let payload: Payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes)) as Payload;
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number" || ahora >= payload.exp) return null;
  if (payload.state !== esperado.state || payload.provider !== esperado.provider) return null;
  if (typeof payload.codeVerifier !== "string") return null;

  return { codeVerifier: payload.codeVerifier, next: payload.next ?? null };
}
