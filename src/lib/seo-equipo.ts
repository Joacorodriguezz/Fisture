// Textos y datos estructurados de la página pública de equipo (docs/33 D1, D2, D3 y D6).
// Funciones puras: la página (equipos/[id].astro) solo las llama con lo que trae de D1.
import { fechaCorta, fechaLarga, hora } from "./format";
import { jsonLdPartido } from "./seo";

interface Equipo {
  id: string;
  name: string;
  logo?: string | null;
}

interface Liga {
  id: string;
  name: string;
}

export interface PartidoDeEquipo {
  match: {
    id: string;
    dateTime: Date;
    venue: string | null;
    status: string | null;
    round?: string | null;
    homeScore?: number | null;
    awayScore?: number | null;
  };
  homeTeam: Equipo;
  awayTeam: Equipo;
  league: Liga;
}

// D1: el título y el <h1> nombran las dos formas en que se busca ("partidos de X", "fixture de X")
export function tituloEquipo(nombre: string): string {
  return `Partidos y fixture de ${nombre} - FISTURE`;
}

export function encabezadoEquipo(nombre: string): string {
  return `Fixture y partidos de ${nombre}`;
}

// Lo distintivo (equipo, liga y próximo partido) va primero: el Layout recorta lo que pase de ~160
export function descripcionEquipo(equipo: Equipo, liga: Liga | null | undefined, proximo?: PartidoDeEquipo): string {
  const detalle = proximo
    ? `próximo partido ${proximo.homeTeam.name} vs ${proximo.awayTeam.name}, ${fechaCorta(proximo.match.dateTime)} a las ${hora(proximo.match.dateTime)}.`
    : "próximos partidos con día y hora, y últimos resultados.";
  return `Partidos y fixture de ${equipo.name}${liga ? ` (${liga.name})` : ""}: ${detalle} Sincronizalo con tu calendario.`;
}

export interface ResultadoDelEquipo {
  propios: number;
  ajenos: number;
  resultado: "ganó" | "perdió" | "empató";
}

// Marcador desde el lado del equipo. Sin los dos goles cargados no hay resultado: nunca se inventa
export function resultadoDelEquipo(
  match: { homeScore?: number | null; awayScore?: number | null },
  esLocal: boolean
): ResultadoDelEquipo | null {
  if (match.homeScore == null || match.awayScore == null) return null;
  const propios = esLocal ? match.homeScore : match.awayScore;
  const ajenos = esLocal ? match.awayScore : match.homeScore;
  const resultado = propios > ajenos ? "ganó" : propios < ajenos ? "perdió" : "empató";
  return { propios, ajenos, resultado };
}

// "sábado 21 de noviembre" (en medio de una oración). También la usa seo-partido.ts
export function diaEnOracion(fecha: Date): string {
  const texto = fechaLarga(fecha);
  return texto.charAt(0).toLowerCase() + texto.slice(1);
}

// Una sede que ya se nombra como estadio no se repite ("en el estadio Estadio Monumental").
// También la usa seo-partido.ts
const SEDE_CON_TIPO = /\b(estadio|est[áa]dio|stadium|stade|stadio|stadion|arena)\b/i;

export function enLaSede(venue: string | null): string {
  const sede = venue?.trim();
  if (!sede) return "";
  return SEDE_CON_TIPO.test(sede) ? `, en el ${sede}` : `, en el estadio ${sede}`;
}

function contexto(teamId: string, partido: PartidoDeEquipo) {
  const esLocal = partido.homeTeam.id === teamId;
  const rival = esLocal ? partido.awayTeam : partido.homeTeam;
  // Sin artículo delante de la competencia: "la La Liga" o "la Brasileirão" no se leen bien
  return { esLocal, texto: `contra ${rival.name}, ${esLocal ? "de local" : "de visitante"}, por ${partido.league.name}` };
}

// D2: una oración completa que responde "cuándo juega X". Sin próximo partido lo dice y, si existe,
// menciona el último resultado.
export function respuestaProximoPartido(equipo: Equipo, proximo?: PartidoDeEquipo, ultimo?: PartidoDeEquipo): string {
  if (proximo) {
    const { dateTime, venue } = proximo.match;
    return `${equipo.name} juega su próximo partido el ${diaEnOracion(dateTime)} a las ${hora(dateTime)} (hora de Argentina) ${contexto(equipo.id, proximo).texto}${enLaSede(venue)}.`;
  }
  const sinProximo = `${equipo.name} todavía no tiene un próximo partido confirmado.`;
  if (!ultimo) return `${sinProximo} Aparece acá apenas se confirme el fixture.`;
  const { esLocal, texto } = contexto(equipo.id, ultimo);
  const r = resultadoDelEquipo(ultimo.match, esLocal);
  const marcador = r ? `, y ${r.resultado} ${r.propios} a ${r.ajenos}` : "";
  return `${sinProximo} Su último partido fue el ${diaEnOracion(ultimo.match.dateTime)} ${texto}${marcador}.`;
}

// D6: los próximos partidos programados como SportsEvent (los postergados o cancelados no se publican)
export const TOPE_EVENTOS_EQUIPO = 10;

export function jsonLdPartidosDeEquipo(publicAppUrl: string, partidos: PartidoDeEquipo[], tope = TOPE_EVENTOS_EQUIPO) {
  return partidos
    .filter((p) => p.match.status === "scheduled")
    .slice(0, tope)
    .map((p) => jsonLdPartido(publicAppUrl, p));
}
