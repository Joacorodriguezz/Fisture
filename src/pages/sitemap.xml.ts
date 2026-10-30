import type { APIContext } from "astro";
import { baseUrl } from "../lib/seo";
import { createDb } from "../lib/db";
import { getPaginasPublicas } from "../lib/db/queries";

// Solo páginas públicas: sin sesión, sin login y sin la API
const PAGINAS_PUBLICAS = ["/", "/ligas", "/partidos", "/calendario", "/hoy", "/equipos/buscar", "/privacidad", "/terminos"];

const entrada = (loc: string, lastmod?: Date | null) =>
  `  <url><loc>${loc}</loc>${lastmod ? `<lastmod>${lastmod.toISOString().slice(0, 10)}</lastmod>` : ""}</url>`;

export async function GET({ locals }: APIContext): Promise<Response> {
  const env = locals.runtime.env;
  const base = baseUrl(env.PUBLIC_APP_URL);
  const { ligas, equipos, partidos } = await getPaginasPublicas(createDb(env.DB));

  // Los ids son de la base (slugs o ids de proveedor): se escapan por las dudas de un "&"
  const xmlId = (id: string) => encodeURIComponent(id).replace(/'/g, "%27");
  const urls = [
    ...PAGINAS_PUBLICAS.map((ruta) => entrada(`${base}${ruta}`)),
    ...ligas.map((l) => entrada(`${base}/ligas/${xmlId(l.id)}`)),
    ...equipos.map((e) => entrada(`${base}/equipos/${xmlId(e.id)}`, e.updatedAt)),
    ...partidos.map((p) => entrada(`${base}/partidos/${xmlId(p.id)}`, p.updatedAt)),
  ].join("\n");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
  return new Response(xml, { headers: { "Content-Type": "application/xml" } });
}
