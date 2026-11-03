import type { APIContext } from "astro";
import { baseUrl } from "../lib/seo";

// La línea Sitemap usa la misma base (PUBLIC_APP_URL) que sitemap.xml
export async function GET({ locals }: APIContext): Promise<Response> {
  // Staging (docs/26) no se indexa
  if (locals.runtime.env.ENVIRONMENT === "staging") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  const base = baseUrl(locals.runtime.env.PUBLIC_APP_URL);
  const texto = `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /configuracion\nDisallow: /login\n\nSitemap: ${base}/sitemap.xml\n`;
  return new Response(texto, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
