// Slugs de las URLs públicas de equipos y ligas (docs/33 D9): `/equipos/atletico-tucuman`.
// Funciones puras: la lectura de los slugs ocupados y la escritura viven en lib/db/slugs.ts.
//
// Reglas:
// - El slug sale del nombre: minúsculas, sin tildes, diacríticos ni apóstrofes; el resto que no sea a-z0-9 pasa a "-".
// - Si choca con otra fila: primero con el país ("liverpool-uruguay"), después con un sufijo numérico
//   desde 2 ("liverpool-2"). Determinístico: mismo orden de filas y mismos ocupados dan el mismo slug.
// - Un slug ya asignado nunca cambia (es la URL pública): quien llama solo asigna a filas sin slug.
// - Nunca con forma de UUID (se confundiría con un id) ni igual a una ruta fija de /equipos/ o /ligas/.

// Letras que NFD no descompone en letra base + diacrítico
const LETRAS_ESPECIALES: Record<string, string> = {
  ß: "ss",
  ø: "o",
  æ: "ae",
  œ: "oe",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i",
};

export function slugificar(nombre: string): string | null {
  const slug = nombre
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[ßøæœłđðþı]/g, (c) => LETRAS_ESPECIALES[c] ?? c)
    // El apóstrofe se quita en lugar de separar: "O'Higgins" es "ohiggins", no "o-higgins"
    .replace(/['’‘ʼ`´]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function pareceUuid(valor: string): boolean {
  return UUID.test(valor);
}

// Rutas fijas bajo /equipos/ y /ligas/ (src/pages/equipos/buscar.astro; "index" por las dudas: Astro
// sirve equipos/index.astro en /equipos, pero /equipos/index no debe poder ser un equipo)
export const SLUGS_RESERVADOS = new Set(["buscar", "index"]);

export function esReservado(slug: string): boolean {
  return SLUGS_RESERVADOS.has(slug) || pareceUuid(slug);
}

// Slug para una fila nueva. `tomados` son los slugs (y los ids) ya ocupados en la tabla. Null si el
// nombre no genera slug: la fila sigue con la URL por id.
export function resolverSlug(nombre: string, pais: string | null, tomados: ReadonlySet<string>): string | null {
  const base = slugificar(nombre);
  if (!base) return null;
  const libre = (s: string) => !tomados.has(s) && !esReservado(s);
  if (libre(base)) return base;

  const sufijoPais = pais ? slugificar(pais) : null;
  if (sufijoPais && !base.endsWith(`-${sufijoPais}`) && libre(`${base}-${sufijoPais}`)) return `${base}-${sufijoPais}`;

  for (let n = 2; ; n++) {
    if (libre(`${base}-${n}`)) return `${base}-${n}`;
  }
}

export interface FilaSinSlug {
  id: string;
  name: string;
  country: string | null;
}

// Asigna slugs a varias filas en el orden recibido. Cada slug asignado se suma a `tomados`, así dos
// filas con el mismo nombre en el mismo lote no chocan. Las filas sin slug posible no aparecen.
export function asignarSlugs(filas: FilaSinSlug[], tomados: Set<string>): Map<string, string> {
  const asignados = new Map<string, string>();
  for (const fila of filas) {
    const slug = resolverSlug(fila.name, fila.country, tomados);
    if (!slug) continue;
    tomados.add(slug);
    asignados.set(fila.id, slug);
  }
  return asignados;
}

// Slugs base distintos de un conjunto de nombres: lo que hay que consultar para saber qué está ocupado
export function basesDeSlug(filas: { name: string }[]): string[] {
  return [...new Set(filas.map((f) => slugificar(f.name)).filter((s): s is string => !!s))];
}

// Rango [desde, hasta) que contiene el slug base y todas sus variantes "base-…" (con país o número):
// "." es el carácter siguiente a "-" y los slugs solo usan a-z, 0-9 y "-", que ordenan después.
// Con él la consulta de ocupados va por el índice único en lugar de un LIKE.
export function rangoDeSlug(base: string): [string, string] {
  return [base, `${base}.`];
}
