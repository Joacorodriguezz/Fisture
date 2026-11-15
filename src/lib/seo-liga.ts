// Textos de la página pública de liga (docs/34 L1 y L2).
// Funciones puras: la página (ligas/[id].astro) solo las llama con lo que trae de D1.
import { hora } from "./format";
import { diaEnOracion, type PartidoDeEquipo } from "./seo-equipo";
import { fraseResultado } from "./seo-partido";

interface Liga {
  name: string;
  country: string;
}

// L1: el título y el <h1> nombran las dos formas en que se busca, como en equipo (docs/33 D1)
export function tituloLiga(nombre: string): string {
  return `Fixture y partidos de ${nombre} - FISTURE`;
}

export function encabezadoLiga(nombre: string): string {
  return `Fixture y partidos de ${nombre}`;
}

// El país solo si no está en el nombre ("Liga Profesional Argentina (Argentina)") y la cantidad solo si
// hay equipos
export function descripcionLiga(liga: Liga, cantidadEquipos: number): string {
  const pais = liga.name.includes(liga.country) ? "" : ` (${liga.country})`;
  const equipos = cantidadEquipos > 0 ? `los ${cantidadEquipos} equipos y sus próximos partidos` : "los próximos partidos";
  return `Fixture y partidos de ${liga.name}${pais}: ${equipos} con día y hora. Sincronizalos con Google Calendar u Outlook.`;
}

// L2: una oración completa que responde "cuándo se juega X". La ronda va entre paréntesis y sin artículo
// ("la Octavos de final" no se lee bien). Sin próximos lo dice y, si existe, nombra el último resultado.
export function respuestaLiga(liga: Liga, proximo?: PartidoDeEquipo, ultimo?: PartidoDeEquipo): string {
  if (proximo) {
    const { dateTime, round } = proximo.match;
    const ronda = round?.trim() ? ` (${round.trim()})` : "";
    return `El próximo partido de ${liga.name} es ${proximo.homeTeam.name} vs ${proximo.awayTeam.name}${ronda}, el ${diaEnOracion(dateTime)} a las ${hora(dateTime)} (hora de Argentina).`;
  }
  const sinProximos = `${liga.name} no tiene partidos programados en los próximos 30 días.`;
  if (!ultimo) return `${sinProximos} Aparecen acá apenas se confirme el fixture.`;
  const dia = `el ${diaEnOracion(ultimo.match.dateTime)}`;
  const resultado = fraseResultado(ultimo);
  return resultado
    ? `${sinProximos} En el último partido, ${resultado} ${dia}.`
    : `${sinProximos} El último partido fue ${ultimo.homeTeam.name} vs ${ultimo.awayTeam.name}, ${dia}.`;
}
