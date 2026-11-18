// Orden de las competencias al listarlas (docs/36 D1): por `prioridad` de LEAGUES_CONFIG, luego por
// nombre; las que no están en la configuración van al final.
import { LEAGUES_CONFIG } from "./data-providers/types";

// Nombre corto para las tarjetas de /ligas, donde el país ya se muestra arriba y un nombre largo ocupa 3
// líneas. Solo se usa para mostrar: `name` sigue siendo el de la URL, el SEO y el calendario.
const NOMBRE_CORTO: Record<string, string> = {
  "arg.1": "Liga Profesional",
  "bol.1": "Liga Boliviana",
  "chi.1": "Primera División",
  "par.1": "Primera División",
  "per.1": "Liga 1",
  "uru.1": "Liga Uruguaya",
  "uefa.champions": "Champions League",
  "uefa.europa": "Europa League",
  "uefa.europa.conf": "Conference League",
  "fifa.worldq.conmebol": "Eliminatorias",
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
