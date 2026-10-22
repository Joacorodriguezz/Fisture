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
