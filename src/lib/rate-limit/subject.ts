// Identidad del sujeto sin datos personales (docs/16 D7): la IP nunca se guarda ni se loguea en claro.
export function ipDe(request: Request): string | null {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return ip ? ip : null;
}

// Normaliza la IP antes del HMAC (docs/16 §12): una IPv6 recibe un /64 entero, así que rotar dentro del
// prefijo no evade el límite. IPv4 queda igual; IPv4-mapped (::ffff:a.b.c.d) se reduce a su IPv4.
// Un valor que no parece IP se devuelve tal cual (el HMAC lo trata como opaco).
export function normalizarIp(ip: string): string {
  const crudo = ip.trim().split("%")[0].toLowerCase();
  if (!crudo.includes(":")) return crudo;

  // Cola IPv4 incrustada (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) -> dos grupos hex
  let texto = crudo;
  const cola = texto.match(/^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (cola) {
    const [a, b, c, d] = cola.slice(2).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return crudo;
    texto = `${cola[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const mitades = texto.split("::");
  if (mitades.length > 2) return crudo;
  const cabeza = mitades[0] ? mitades[0].split(":") : [];
  const resto = mitades.length === 2 && mitades[1] ? mitades[1].split(":") : [];
  const faltan = 8 - cabeza.length - resto.length;
  if ((mitades.length === 1 && faltan !== 0) || (mitades.length === 2 && faltan < 1)) return crudo;
  const grupos = [...cabeza, ...Array<string>(mitades.length === 2 ? faltan : 0).fill("0"), ...resto];
  if (grupos.length !== 8 || !grupos.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return crudo;
  const n = grupos.map((g) => parseInt(g, 16));

  if (n.slice(0, 5).every((x) => x === 0) && n[5] === 0xffff) return `${n[6] >> 8}.${n[6] & 255}.${n[7] >> 8}.${n[7] & 255}`;
  return `${n.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`;
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
  return ip && salt ? hashIp(normalizarIp(ip), salt) : null;
}
