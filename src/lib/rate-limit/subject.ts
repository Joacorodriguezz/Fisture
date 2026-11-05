// Identidad del sujeto sin datos personales (docs/16 D7): la IP nunca se guarda ni se loguea en claro.
export function ipDe(request: Request): string | null {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return ip ? ip : null;
}

// Material del HMAC: el secret propio y, si falta, ADMIN_SECRET (docs/16 R6)
export function saltDe(env: { RATE_LIMIT_SALT?: string; ADMIN_SECRET?: string }): string | null {
  return env.RATE_LIMIT_SALT || env.ADMIN_SECRET || null;
}

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function hashIp(ip: string, salt: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(ip)));
  return base64url(firma).slice(0, 22);
}

// Sujeto de IP de la request, o null si no hay IP o no hay con qué hashearla (el scope IP se omite)
export async function sujetoIp(request: Request, env: { RATE_LIMIT_SALT?: string; ADMIN_SECRET?: string }): Promise<string | null> {
  const ip = ipDe(request);
  const salt = saltDe(env);
  return ip && salt ? hashIp(ip, salt) : null;
}
