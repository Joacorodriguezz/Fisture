// Utilidades de SEO compartidas por el layout y el sitemap.

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

// Ruta de una liga, equipo o partido. El id va codificado como en la URL que pide el navegador,
// así el sitemap, el JSON-LD y la canónica (Astro.url.pathname) apuntan a la misma dirección.
export function rutaPublica(seccion: "ligas" | "equipos" | "partidos", id: string): string {
  return `/${seccion}/${encodeURIComponent(id)}`;
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
        url: `${base}/`,
        inLanguage: "es-AR",
        description: "Sincronizá los partidos de tus equipos y ligas de fútbol con tu calendario personal.",
        publisher: { "@id": `${base}/#organizacion` },
      },
      {
        "@type": "Organization",
        "@id": `${base}/#organizacion`,
        name: NOMBRE_SITIO,
        url: `${base}/`,
        logo: `${base}/favicon.svg`,
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

interface EquipoLd {
  id: string;
  name: string;
  logo?: string | null;
}

function equipoLd(base: string, equipo: EquipoLd) {
  return {
    "@type": "SportsTeam",
    name: equipo.name,
    sport: "Soccer",
    url: `${base}${rutaPublica("equipos", equipo.id)}`,
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
    league: { id: string; name: string };
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
    superEvent: { "@type": "SportsEvent", name: league.name, url: `${base}${rutaPublica("ligas", league.id)}` },
    ...([homeTeam.logo, awayTeam.logo].some(Boolean) ? { image: [homeTeam.logo, awayTeam.logo].filter(Boolean) } : {}),
  };
}

export function jsonLdEquipo(publicAppUrl: string, equipo: EquipoLd, liga?: { id: string; name: string } | null) {
  const base = baseUrl(publicAppUrl);
  return {
    "@context": "https://schema.org",
    ...equipoLd(base, equipo),
    ...(liga ? { memberOf: { "@type": "SportsOrganization", name: liga.name, url: `${base}${rutaPublica("ligas", liga.id)}` } } : {}),
  };
}

export function jsonLdLiga(publicAppUrl: string, liga: { id: string; name: string; country: string }, equipos: EquipoLd[]) {
  const base = baseUrl(publicAppUrl);
  return {
    "@context": "https://schema.org",
    "@type": "SportsOrganization",
    name: liga.name,
    sport: "Soccer",
    url: `${base}${rutaPublica("ligas", liga.id)}`,
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
