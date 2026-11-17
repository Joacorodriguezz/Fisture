// Logos propios de las competencias (docs/36 D2): archivos de public/logos/competencias, uno por externalId.
// Tienen prioridad sobre el que informa ESPN; las competencias que no están acá (p. ej. las Eliminatorias)
// usan el de ESPN.
export const LOGOS_PROPIOS: Record<string, string> = Object.fromEntries(
  [
    ["arg.1", "png"], ["bra.1", "png"], ["uru.1", "png"], ["col.1", "png"], ["chi.1", "png"],
    ["ecu.1", "png"], ["par.1", "png"], ["per.1", "png"], ["bol.1", "svg"], ["ven.1", "png"],
    ["eng.1", "png"], ["esp.1", "png"], ["ita.1", "png"], ["ger.1", "png"], ["fra.1", "png"],
    ["conmebol.libertadores", "png"], ["conmebol.sudamericana", "png"],
    ["uefa.champions", "png"], ["uefa.europa", "png"], ["uefa.europa.conf", "png"],
  ].map(([id, ext]) => [id, `/logos/competencias/${id}.${ext}`])
);

export function logoDeCompetencia(externalId: string, logoEspn?: string | null): string | null {
  return LOGOS_PROPIOS[externalId] ?? logoEspn ?? null;
}
