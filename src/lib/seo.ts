// Utilidades de SEO compartidas por el layout y el sitemap.
import { CONTACTO_EMAIL } from "./legal";

// Base absoluta sin barras finales (PUBLIC_APP_URL puede venir con o sin "/")
export function baseUrl(publicAppUrl: string): string {
  return publicAppUrl.replace(/\/+$/, "");
}

// Ruta canónica: sin barra final salvo en la raíz
export function normalizarRuta(pathname: string): string {
  if (pathname === "/") return pathname;
  return pathname.replace(/\/+$/, "") || "/";
}

// URL absoluta canónica de una página (sin query string)
export function urlCanonica(publicAppUrl: string, pathname: string): string {
  return `${baseUrl(publicAppUrl)}${normalizarRuta(pathname)}`;
}

// Liga o equipo con su slug (docs/33 D9). Sin slug (nombre sin letras, o antes del backfill) la URL
// sigue siendo la del id.
export interface EntidadConSlug {
  id: string;
  slug?: string | null;
}

// Única fuente de la URL pública de una liga, equipo o partido: canónica, sitemap, JSON-LD, migas,
// llms.txt y enlaces internos. Equipos y ligas usan el slug cuando existe y el id cuando no; los
// partidos siempre el id (la fecha cambia con las reprogramaciones). El segmento va codificado como
// en la URL que pide el navegador, así todo apunta a la misma dirección que Astro.url.pathname.
export function rutaPublica(seccion: "partidos", id: string): string;
export function rutaPublica(seccion: "ligas" | "equipos", entidad: EntidadConSlug): string;
export function rutaPublica(seccion: "ligas" | "equipos" | "partidos", valor: string | EntidadConSlug): string {
  const segmento = typeof valor === "string" ? valor : valor.slug || valor.id;
  return `/${seccion}/${encodeURIComponent(segmento)}`;
}

// Página de equipo o liga pedida por `pedido` (slug o id): si llegó por id y la fila ya tiene slug,
// devuelve la URL con nombre (con el mismo query string) para responder 301. Null = servir la página:
// llegó por slug, o la fila todavía no tiene slug (transición).
export function redireccionASlug(seccion: "ligas" | "equipos", pedido: string, entidad: EntidadConSlug, search = ""): string | null {
  if (!entidad.slug || entidad.slug === pedido) return null;
  return `${rutaPublica(seccion, entidad)}${search}`;
}

// Dominio único (docs/29): en producción, un pedido que llega por otro host (fisture.pages.dev, www.,
// el alias de un deploy) se redirige con 301 a la misma ruta en PUBLIC_APP_URL. Así Google ve una sola
// versión del sitio. Devuelve la URL de destino, o null si el pedido ya está en el dominio canónico.
// Quedan afuera: otros entornos (staging, test, dev), la API (webhooks y scripts usan su propia URL),
// los métodos que no son GET/HEAD y los pedidos locales.
const HOSTS_LOCALES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function destinoDominioCanonico(url: URL, metodo: string, entorno: string, publicAppUrl: string): string | null {
  if (entorno !== "production") return null;
  if (metodo !== "GET" && metodo !== "HEAD") return null;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return null;
  if (HOSTS_LOCALES.has(url.hostname)) return null;
  let canonica: URL;
  try {
    canonica = new URL(baseUrl(publicAppUrl));
  } catch {
    return null;
  }
  if (url.host === canonica.host && url.protocol === canonica.protocol) return null;
  return `${canonica.origin}${url.pathname}${url.search}`;
}

// Google muestra unos 155-160 caracteres de la descripción: se corta en un espacio y se marca con "…"
export const LARGO_DESCRIPCION = 160;

export function recortarDescripcion(texto: string, max = LARGO_DESCRIPCION): string {
  const limpio = texto.replace(/\s+/g, " ").trim();
  if (limpio.length <= max) return limpio;
  const corte = limpio.slice(0, max - 1);
  const espacio = corte.lastIndexOf(" ");
  return `${(espacio > max / 2 ? corte.slice(0, espacio) : corte).replace(/[\s,;:(-]+$/, "")}…`;
}

// Texto dentro de un elemento XML (sitemap)
export function escaparXml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Texto de un link markdown (llms.txt): corchetes y marcadores de énfasis escapados
export function escaparMarkdown(texto: string): string {
  return texto.replace(/[\\`*_[\]]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Datos estructurados (JSON-LD de schema.org) para buscadores y motores de IA.
// Cada función devuelve un objeto plano; JsonLd.astro lo serializa en el <head>.

export const NOMBRE_SITIO = "FISTURE";

// Otras formas en que se busca la marca: Google las usa para el nombre del sitio en los resultados
export const NOMBRES_ALTERNATIVOS = ["Fisture", "Fisture app", "Fixture Sync"];

// Perfiles oficiales de la marca (Instagram, X, etc.). Le dicen a Google que "fisture" es este sitio y
// no un error de tipeo de "fissure" (docs/29). Sumar cada perfil acá cuando exista; nunca uno ajeno.
export const PERFILES_DE_MARCA: string[] = [];
const DURACION_PARTIDO_MS = 2 * 60 * 60 * 1000;

// JSON dentro de <script>: "<" escapado para que un nombre con "</script>" no cierre la etiqueta
export function serializarJsonLd(datos: unknown): string {
  return JSON.stringify(datos).replace(/</g, "\\u003c");
}

export function jsonLdSitio(publicAppUrl: string) {
  const base = baseUrl(publicAppUrl);
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebSite",
        "@id": `${base}/#sitio`,
        name: NOMBRE_SITIO,
        alternateName: NOMBRES_ALTERNATIVOS,
        url: `${base}/`,
        inLanguage: "es-AR",
        description: "Sincronizá los partidos de tus equipos y ligas de fútbol con tu calendario personal.",
        publisher: { "@id": `${base}/#organizacion` },
      },
      {
        "@type": "Organization",
        "@id": `${base}/#organizacion`,
        name: NOMBRE_SITIO,
        alternateName: NOMBRES_ALTERNATIVOS,
        url: `${base}/`,
        // Google pide un logo rasterizado de al menos 112×112: el SVG lo ignora
        logo: { "@type": "ImageObject", url: `${base}/icon-512.png`, width: 512, height: 512 },
        email: CONTACTO_EMAIL,
        ...(PERFILES_DE_MARCA.length > 0 ? { sameAs: PERFILES_DE_MARCA } : {}),
      },
      {
        "@type": "WebApplication",
        name: NOMBRE_SITIO,
        url: `${base}/`,
        applicationCategory: "SportsApplication",
        operatingSystem: "Web",
        inLanguage: "es-AR",
        offers: { "@type": "Offer", price: "0", priceCurrency: "ARS" },
        featureList: [
          "Fixture de fútbol sincronizado con Google Calendar y Outlook",
          "Horarios que se actualizan solos si el partido se reprograma",
          "Recordatorios 1 hora y 15 minutos antes",
        ],
      },
    ],
  };
}

interface EquipoLd extends EntidadConSlug {
  name: string;
  logo?: string | null;
}

function equipoLd(base: string, equipo: EquipoLd) {
  return {
    "@type": "SportsTeam",
    name: equipo.name,
    sport: "Soccer",
    url: `${base}${rutaPublica("equipos", equipo)}`,
    ...(equipo.logo ? { logo: equipo.logo } : {}),
  };
}

const ESTADOS_EVENTO: Record<string, string> = {
  postponed: "https://schema.org/EventPostponed",
  cancelled: "https://schema.org/EventCancelled",
};

export function jsonLdPartido(
  publicAppUrl: string,
  datos: {
    match: { id: string; dateTime: Date; venue: string | null; status: string | null; round?: string | null };
    homeTeam: EquipoLd;
    awayTeam: EquipoLd;
    league: EntidadConSlug & { name: string };
  }
) {
  const base = baseUrl(publicAppUrl);
  const { match, homeTeam, awayTeam, league } = datos;
  const local = equipoLd(base, homeTeam);
  const visitante = equipoLd(base, awayTeam);
  return {
    "@context": "https://schema.org",
    "@type": "SportsEvent",
    name: `${homeTeam.name} vs ${awayTeam.name}`,
    description: `${homeTeam.name} vs ${awayTeam.name} por ${league.name}${match.round ? ` (${match.round})` : ""}.`,
    url: `${base}${rutaPublica("partidos", match.id)}`,
    sport: "Soccer",
    startDate: match.dateTime.toISOString(),
    endDate: new Date(match.dateTime.getTime() + DURACION_PARTIDO_MS).toISOString(),
    eventStatus: ESTADOS_EVENTO[match.status ?? ""] ?? "https://schema.org/EventScheduled",
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
    // Google pide la dirección de la sede para el rich result de eventos, pero solo tenemos el nombre
    // del estadio: se publica eso y no se inventan dirección, organizer ni offers
    ...(match.venue ? { location: { "@type": "Place", name: match.venue } } : {}),
    homeTeam: local,
    awayTeam: visitante,
    competitor: [local, visitante],
    performer: [local, visitante],
    superEvent: { "@type": "SportsEvent", name: league.name, url: `${base}${rutaPublica("ligas", league)}` },
    ...([homeTeam.logo, awayTeam.logo].some(Boolean) ? { image: [homeTeam.logo, awayTeam.logo].filter(Boolean) } : {}),
  };
}

export function jsonLdEquipo(publicAppUrl: string, equipo: EquipoLd, liga?: (EntidadConSlug & { name: string }) | null) {
  const base = baseUrl(publicAppUrl);
  return {
    "@context": "https://schema.org",
    ...equipoLd(base, equipo),
    ...(liga ? { memberOf: { "@type": "SportsOrganization", name: liga.name, url: `${base}${rutaPublica("ligas", liga)}` } } : {}),
  };
}

export function jsonLdLiga(publicAppUrl: string, liga: EntidadConSlug & { name: string; country: string }, equipos: EquipoLd[]) {
  const base = baseUrl(publicAppUrl);
  return {
    "@context": "https://schema.org",
    "@type": "SportsOrganization",
    name: liga.name,
    sport: "Soccer",
    url: `${base}${rutaPublica("ligas", liga)}`,
    areaServed: liga.country,
    member: equipos.map((e) => equipoLd(base, e)),
  };
}

// Migas de pan: [{ nombre, ruta }] desde la raíz hasta la página actual (rutas ya codificadas)
export function jsonLdMigas(publicAppUrl: string, migas: { nombre: string; ruta: string }[]) {
  const base = baseUrl(publicAppUrl);
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: migas.map((m, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: m.nombre,
      item: `${base}${normalizarRuta(m.ruta)}`,
    })),
  };
}
