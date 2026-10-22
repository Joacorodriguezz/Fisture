import type { APIContext } from "astro";

// Solo páginas públicas y estáticas: sin sesión, sin login y sin la API
const PAGINAS_PUBLICAS = ["/", "/ligas", "/partidos", "/calendario", "/hoy", "/privacidad", "/terminos"];

export async function GET({ locals }: APIContext): Promise<Response> {
  const base = locals.runtime.env.PUBLIC_APP_URL.replace(/\/+$/, "");
  const urls = PAGINAS_PUBLICAS.map((ruta) => `  <url><loc>${base}${ruta}</loc></url>`).join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
