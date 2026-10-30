// Headers de seguridad que el middleware agrega a toda respuesta del Worker.
// Los assets estáticos (/_astro/*, favicon) no pasan por el Worker: esos llevan los mismos
// headers fijos desde public/_headers.
import islaAstro from "astro/runtime/server/astro-island.prebuilt.js";
import islaAstroDev from "astro/runtime/server/astro-island.prebuilt-dev.js";
import directivaIdle from "astro/runtime/client/idle.prebuilt.js";
import directivaLoad from "astro/runtime/client/load.prebuilt.js";
import directivaMedia from "astro/runtime/client/media.prebuilt.js";
import directivaOnly from "astro/runtime/client/only.prebuilt.js";
import directivaVisible from "astro/runtime/client/visible.prebuilt.js";

export const HEADERS_FIJOS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
};

// Tema oscuro antes del primer pintado (Layout.astro lo inserta con set:html para que el hash coincida byte a byte)
export const SCRIPT_TEMA =
  'try { if (matchMedia("(prefers-color-scheme: dark)").matches) document.documentElement.dataset.theme = "nocturna"; } catch (e) {}';

// Únicos scripts inline autorizados: el del tema y los que Astro escribe para hidratar islands
// (definición de <astro-island> + un script por directiva client:*). Se hashea esta lista fija y no el HTML
// de la respuesta: así un <script> inyectado en la página no queda autorizado. Los <script> de componentes
// salen como archivos en /_astro (assetsInlineLimit en astro.config.mjs) y entran por 'self'.
export const SCRIPTS_INLINE = [
  SCRIPT_TEMA,
  islaAstro,
  islaAstroDev,
  directivaIdle,
  directivaLoad,
  directivaMedia,
  directivaOnly,
  directivaVisible,
];

export async function hashScript(contenido: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(contenido));
  return `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`;
}

// Los estilos inline (atributos style="" de los componentes) obligan a 'unsafe-inline' en style-src;
// los scripts no: cada script inline se autoriza por su hash.
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

// La lista es fija: la CSP se calcula una vez por isolate
let csp: Promise<string> | undefined;
export function cspDeLaApp(): Promise<string> {
  csp ??= Promise.all(SCRIPTS_INLINE.map(hashScript)).then(construirCsp);
  return csp;
}

// Devuelve la respuesta con los headers de seguridad, sin leer el cuerpo (el HTML sigue saliendo en streaming).
// `conCsp` es false en `astro dev`: el dev toolbar escribe un script inline distinto en cada página.
export async function conHeadersDeSeguridad(res: Response, conCsp = true): Promise<Response> {
  // Copia: las respuestas de Response.redirect() tienen los headers inmutables
  const salida = new Response(res.body, res);
  for (const [nombre, valor] of Object.entries(HEADERS_FIJOS)) {
    salida.headers.set(nombre, valor);
  }
  if (conCsp) salida.headers.set("Content-Security-Policy", await cspDeLaApp());
  return salida;
}
