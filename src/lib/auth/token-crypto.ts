// Cifrado de tokens OAuth en reposo (docs/15-cifrado-de-tokens-tdd.md).
// Formato: enc:v1:<iv>:<ciphertext+tag>, ambos en base64url. AES-256-GCM con WebCrypto.
// El AAD (`<id>:<columna>`) ata el texto cifrado a su fila y columna.
export const PREFIJO_CIFRADO = "enc:v1:";

export interface ClavesEnv {
  TOKEN_ENCRYPTION_KEY?: string;
  TOKEN_ENCRYPTION_KEY_PREVIOUS?: string;
}

// Falta la clave o no tiene 32 bytes. El mensaje nunca incluye la clave
export class TokenKeyError extends Error {
  constructor(mensaje = "token_key_missing") {
    super(mensaje);
    this.name = "TokenKeyError";
  }
}

export type OrigenClave = "claro" | "actual" | "anterior";

const enc = new TextEncoder();
const dec = new TextDecoder();
const cacheClaves = new Map<string, Promise<CryptoKey>>();

export function esCifrado(valor: string): boolean {
  return valor.startsWith(PREFIJO_CIFRADO);
}

function base64urlDe(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesDeBase64(valor: string): Uint8Array {
  const b64 = valor.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function crudaDe(base64: string | undefined): Uint8Array | null {
  if (!base64) return null;
  try {
    const crudo = bytesDeBase64(base64.trim());
    return crudo.length === 32 ? crudo : null;
  } catch {
    return null;
  }
}

function importar(base64: string | undefined): Promise<CryptoKey> {
  const crudo = crudaDe(base64);
  if (!crudo) throw new TokenKeyError(base64 ? "token_key_invalid" : "token_key_missing");
  const id = base64!.trim();
  let promesa = cacheClaves.get(id);
  if (!promesa) {
    promesa = crypto.subtle.importKey("raw", crudo as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
    cacheClaves.set(id, promesa);
  }
  return promesa;
}

// ¿La clave actual está cargada y es válida? (check de salud)
export function claveValida(env: ClavesEnv): boolean {
  return crudaDe(env.TOKEN_ENCRYPTION_KEY) !== null;
}

// ¿La clave anterior (rotación) está ausente o es válida? Una PREVIOUS mal formada rompería el backfill
export function clavePreviaValida(env: ClavesEnv): boolean {
  return !env.TOKEN_ENCRYPTION_KEY_PREVIOUS || crudaDe(env.TOKEN_ENCRYPTION_KEY_PREVIOUS) !== null;
}

// El valor cifrado no se puede leer (otra clave, otra fila o alterado). Nunca lleva el valor ni el detalle del fallo
export class TokenUnreadableError extends Error {
  constructor() {
    super("token_unreadable");
    this.name = "TokenUnreadableError";
  }
}

export async function encryptToken(env: ClavesEnv, valor: string, aad: string): Promise<string> {
  const clave = await importar(env.TOKEN_ENCRYPTION_KEY);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cifrado = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(aad) }, clave, enc.encode(valor));
  return `${PREFIJO_CIFRADO}${base64urlDe(iv)}:${base64urlDe(new Uint8Array(cifrado))}`;
}

async function descifrarCon(clave: CryptoKey, valor: string, aad: string): Promise<string> {
  const [ivB64, dataB64, resto] = valor.slice(PREFIJO_CIFRADO.length).split(":");
  if (!ivB64 || !dataB64 || resto !== undefined) throw new Error("token_format_invalid");
  const plano = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytesDeBase64(ivB64) as BufferSource, additionalData: enc.encode(aad) },
    clave,
    bytesDeBase64(dataB64) as BufferSource
  );
  return dec.decode(plano);
}

// Lee ambos formatos (docs/15 D5): un valor sin prefijo es legado en claro. Informa con qué clave se descifró
export async function decryptTokenInfo(env: ClavesEnv, valor: string, aad: string): Promise<{ valor: string; clave: OrigenClave }> {
  if (!esCifrado(valor)) return { valor, clave: "claro" };
  const actual = await importar(env.TOKEN_ENCRYPTION_KEY);
  try {
    return { valor: await descifrarCon(actual, valor, aad), clave: "actual" };
  } catch {
    // Sin clave anterior (o si tampoco sirve) el valor es ilegible: error sin detalle
    if (!env.TOKEN_ENCRYPTION_KEY_PREVIOUS) throw new TokenUnreadableError();
    const anterior = await importar(env.TOKEN_ENCRYPTION_KEY_PREVIOUS);
    try {
      return { valor: await descifrarCon(anterior, valor, aad), clave: "anterior" };
    } catch {
      throw new TokenUnreadableError();
    }
  }
}

export async function decryptToken(env: ClavesEnv, valor: string, aad: string): Promise<string> {
  return (await decryptTokenInfo(env, valor, aad)).valor;
}
