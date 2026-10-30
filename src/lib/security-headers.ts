// Headers de seguridad que el middleware agrega a toda respuesta del Worker.
// Los assets estáticos (/_astro/*, favicon) no pasan por el Worker: esos llevan los mismos
// headers fijos desde public/_headers.

export const HEADERS_FIJOS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
};

// Los estilos inline (atributos style="" de los componentes) obligan a 'unsafe-inline' en style-src;
// los scripts no: cada <script> inline se autoriza por su hash (ver hashesDeScriptsInline).
export function construirCsp(scriptHashes: string[]): string {
  return [
    "default-src 'self'",
    `script-src 'self'${scriptHashes.map((h) => ` '${h}'`).join("")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // Los escudos son <img> remotos de los proveedores de datos
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Scripts inline de Astro (definición de <astro-island>, scripts de componentes chicos) y del layout.
// Los que tienen src ya quedan cubiertos por 'self'.
const SCRIPT_INLINE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

export async function hashesDeScriptsInline(html: string): Promise<string[]> {
  const contenidos = new Set<string>();
  for (const [, atributos, contenido] of html.matchAll(SCRIPT_INLINE)) {
    if (/\bsrc\s*=/i.test(atributos) || contenido.trim() === "") continue;
    contenidos.add(contenido);
  }

  return Promise.all(
    [...contenidos].map(async (contenido) => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contenido));
      return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
    })
  );
}

// Devuelve una respuesta con los headers de seguridad. La CSP solo va en HTML: es lo único que la usa,
// y para calcular los hashes hay que leer el cuerpo completo.
export async function conHeadersDeSeguridad(res: Response): Promise<Response> {
  const esHtml = res.headers.get("Content-Type")?.includes("text/html") ?? false;
  const cuerpo = esHtml ? await res.text() : res.body;
  const salida = new Response(cuerpo, res);

  for (const [nombre, valor] of Object.entries(HEADERS_FIJOS)) {
    salida.headers.set(nombre, valor);
  }
  if (esHtml) {
    salida.headers.set("Content-Security-Policy", construirCsp(await hashesDeScriptsInline(cuerpo as string)));
  }
  return salida;
}
