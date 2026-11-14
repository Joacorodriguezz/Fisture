// Los logos de ESPN vienen en 500 px (60 a 140 KB cada uno) y se muestran a 32–72 px. Su servicio de
// imágenes devuelve el mismo PNG reducido (unos 7 KB a 96 px). Sin dependencias: lo usan también las islas.
const LOGO_ESPN = /^https:\/\/a\.espncdn\.com(\/i\/teamlogos\/[^?#]+\.png)$/;

// Pocos anchos fijos, para que un escudo se descargue una vez y sirva en todas las páginas. Por encima
// de 192 px la reducción casi no ahorra y se deja el original.
const ANCHOS = [96, 192];

// URL del escudo para mostrarlo a `size` px de lado: el doble, por las pantallas de alta densidad.
// Cualquier otra URL (otro proveedor, ya reducida, con parámetros) vuelve tal cual.
export function urlEscudo(src: string, size: number): string {
  const ruta = LOGO_ESPN.exec(src)?.[1];
  const ancho = ANCHOS.find((a) => a >= size * 2);
  if (!ruta || !ancho) return src;
  return `https://a.espncdn.com/combiner/i?img=${ruta}&w=${ancho}&h=${ancho}`;
}
