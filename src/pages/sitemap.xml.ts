import type { APIContext } from "astro";
import { baseUrl, escaparXml, rutaPublica } from "../lib/seo";
import { createDb } from "../lib/db";
import { getPaginasPublicas } from "../lib/db/queries";

// Solo páginas públicas: sin sesión, sin login y sin la API
const PAGINAS_PUBLICAS = ["/", "/ligas", "/partidos", "/calendario", "/hoy", "/equipos/buscar", "/privacidad", "/terminos"];

// Límite del protocolo por archivo; si se llega, quedan afuera los partidos más lejanos
const MAX_URLS_SITEMAP = 50_000;

// Los datos cambian una vez por día (sync de las 9:00 UTC): con una hora de caché alcanza
const CACHE_SITEMAP = "public, max-age=3600";

const entrada = (loc: string, lastmod?: Date | null) =>
  `  <url><loc>${escaparXml(loc)}</loc>${lastmod ? `<lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod>` : ""}</url>`;

export async function GET({ locals }: APIContext): Promise<Response> {
  const env = locals.runtime.env;
  const base = baseUrl(env.PUBLIC_APP_URL);
  const { ligas, equipos, partidos } = await getPaginasPublicas(createDb(env.DB));

  // Mismas rutas que la canónica y el JSON-LD (rutaPublica); escaparXml cubre "&" y comillas
  const urls = [
    ...PAGINAS_PUBLICAS.map((ruta) => entrada(`${base}${ruta}`)),
    ...ligas.map((l) => entrada(`${base}${rutaPublica("ligas", l.id)}`)),
    ...equipos.map((e) => entrada(`${base}${rutaPublica("equipos", e.id)}`)),
    ...partidos.map((p) => entrada(`${base}${rutaPublica("partidos", p.id)}`, p.updatedAt)),
  ]
    .slice(0, MAX_URLS_SITEMAP)
    .join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": CACHE_SITEMAP } });
}
