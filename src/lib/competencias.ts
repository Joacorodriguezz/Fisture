// Orden de las competencias al listarlas (docs/36 D1): por `prioridad` de LEAGUES_CONFIG, luego por
// nombre; las que no están en la configuración van al final.
import { LEAGUES_CONFIG } from "./data-providers/types";

// Nombre corto para las tarjetas de /ligas: "División Profesional de Bolivia" ocupa 3 líneas. Solo se usa
// para mostrar: `name` sigue siendo el de la URL, el SEO y el calendario.
const NOMBRE_CORTO: Record<string, string> = {
  "bol.1": "Liga Boliviana",
};

export function nombreCorto(externalId: string | null, name: string): string {
  return (externalId ? NOMBRE_CORTO[externalId] : undefined) ?? name;
}

const PRIORIDAD_POR_EXTERNAL_ID = new Map(LEAGUES_CONFIG.map((c) => [c.externalId, c.prioridad]));

export function ordenarCompetencias<T extends { externalId: string | null; name: string }>(filas: readonly T[]): T[] {
  const prioridad = (f: T) =>
    (f.externalId ? PRIORIDAD_POR_EXTERNAL_ID.get(f.externalId) : undefined) ?? Number.POSITIVE_INFINITY;
  return [...filas].sort((a, b) => {
    const pa = prioridad(a);
    const pb = prioridad(b);
    if (pa !== pb) return pa < pb ? -1 : 1;
    return a.name.localeCompare(b.name, "es");
  });
}
