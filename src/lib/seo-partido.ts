// Textos de la página pública de partido (docs/33 D2 y D3).
// Funciones puras: la página (partidos/[id].astro) solo las llama con lo que trae getMatchDetail.
import { hora } from "./format";
import { diaEnOracion, enLaSede, type PartidoDeEquipo } from "./seo-equipo";

type Partido = PartidoDeEquipo;

export interface Marcador {
  local: number;
  visitante: number;
}

// Solo un partido terminado con los dos goles cargados tiene resultado: nunca se inventa. Un marcador
// parcial (en juego) o un dato suelto en un programado no se publica como resultado.
export function marcadorPartido(match: Partido["match"]): Marcador | null {
  if (match.status !== "finished" || match.homeScore == null || match.awayScore == null) return null;
  return { local: match.homeScore, visitante: match.awayScore };
}

// "River Plate 1, Boca Juniors 2" (renglón "Resultado:" de la ficha)
export function textoResultado(partido: Partido): string | null {
  const m = marcadorPartido(partido.match);
  if (!m) return null;
  return `${partido.homeTeam.name} ${m.local}, ${partido.awayTeam.name} ${m.visitante}`;
}

// "el domingo 1 de noviembre a las 15:00 (hora de Argentina)"
function cuando(dateTime: Date): string {
  return `el ${diaEnOracion(dateTime)} a las ${hora(dateTime)} (hora de Argentina)`;
}

// D2: una oración completa que responde qué pasa con el partido, según su estado. Sin artículo delante
// de la competencia (decisión del paso 1: "por La Liga", no "por la La Liga").
export function respuestaPartido(partido: Partido): string {
  const { match, homeTeam, awayTeam, league } = partido;
  const sede = enLaSede(match.venue);
  const local = homeTeam.name;
  const visitante = awayTeam.name;

  switch (match.status) {
    case "finished": {
      const m = marcadorPartido(match);
      if (!m) {
        return `${local} y ${visitante} jugaron ${cuando(match.dateTime)} por ${league.name}${sede}. El resultado todavía no está cargado.`;
      }
      const dia = `el ${diaEnOracion(match.dateTime)}, por ${league.name}${sede}.`;
      if (m.local === m.visitante) return `${local} y ${visitante} empataron ${m.local} a ${m.visitante} ${dia}`;
      const ganaLocal = m.local > m.visitante;
      const [ganador, perdedor] = ganaLocal ? [local, visitante] : [visitante, local];
      const [mas, menos] = ganaLocal ? [m.local, m.visitante] : [m.visitante, m.local];
      return `${ganador} le ganó ${mas} a ${menos} a ${perdedor} ${dia}`;
    }
    case "live":
      return `${local} y ${visitante} están jugando: el partido empezó ${cuando(match.dateTime)}, por ${league.name}${sede}.`;
    case "postponed":
      return `El partido entre ${local} y ${visitante} por ${league.name}, previsto para ${cuando(match.dateTime)}, fue postergado. La nueva fecha todavía no está confirmada.`;
    case "cancelled":
      return `El partido entre ${local} y ${visitante} por ${league.name}, previsto para ${cuando(match.dateTime)}, fue cancelado.`;
    default:
      return `${local} y ${visitante} juegan ${cuando(match.dateTime)} por ${league.name}${sede}.`;
  }
}

// Meta descripción. Un partido terminado no invita a agendarlo: dice cuándo se jugó y, si existe, el
// resultado (primero, porque el Layout recorta lo que pase de ~160 caracteres).
export function descripcionPartido(partido: Partido): string {
  const { match, homeTeam, awayTeam, league } = partido;
  const dia = `${diaEnOracion(match.dateTime)} a las ${hora(match.dateTime)} (hora argentina)${match.venue ? ` en ${match.venue}` : ""}`;
  if (match.status === "finished") {
    const m = marcadorPartido(match);
    return m
      ? `${homeTeam.name} ${m.local}-${m.visitante} ${awayTeam.name} por ${league.name}: se jugó el ${dia}. Resultado y ficha del partido.`
      : `${homeTeam.name} vs ${awayTeam.name} por ${league.name}: se jugó el ${dia}. Ficha del partido y fixture de los dos equipos.`;
  }
  // Un cancelado o un postergado tampoco invitan a agendarlo con una fecha que ya no vale
  if (match.status === "cancelled") {
    return `${homeTeam.name} vs ${awayTeam.name} por ${league.name}: fue cancelado. Estaba previsto para el ${dia}.`;
  }
  if (match.status === "postponed") {
    return `${homeTeam.name} vs ${awayTeam.name} por ${league.name}: fue postergado y todavía no tiene nueva fecha. Si lo tenés en tu calendario, se actualiza solo.`;
  }
  // Después de los dos puntos va en minúscula: "por Liga Profesional: sábado 10 de octubre a las 15:00"
  return `${homeTeam.name} vs ${awayTeam.name} por ${league.name}: ${dia}. Agregalo a tu calendario con recordatorios.`;
}
