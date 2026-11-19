// Reglas del prode (docs/37-prode-reglas.md). Lógica pura: sin D1, sin red.

/** Goles a los 90 minutos más el adicionado (sin alargue ni penales). */
export interface Marcador {
  local: number;
  visitante: number;
}

/** Totales de un participante en el ranking. `aciertos` cuenta todo pronóstico que sumó puntos (exactos incluidos). */
export interface Participante {
  nombre: string;
  puntos: number;
  exactos: number;
  aciertos: number;
}

export const PUNTOS_EXACTO = 3;
export const PUNTOS_ACIERTO = 1;

const signo = (m: Marcador) => Math.sign(m.local - m.visitante);

/**
 * Puntos de un pronóstico: 3 por el resultado exacto; si no, 1 por acertar ganador o empate; si no, 0.
 * No se acumulan. Sin pronóstico o sin resultado válido (cancelado, sin jugar) da 0.
 */
export function calcularPuntos(pronostico: Marcador | null, resultado: Marcador | null): number {
  if (!pronostico || !resultado) return 0;
  if (pronostico.local === resultado.local && pronostico.visitante === resultado.visitante) return PUNTOS_EXACTO;
  return signo(pronostico) === signo(resultado) ? PUNTOS_ACIERTO : 0;
}

const nombres = new Intl.Collator("es", { sensitivity: "base" });

/**
 * Orden del ranking, para `Array.prototype.sort`: más puntos, luego más exactos, luego más aciertos
 * y, con todo igualado, nombre visible alfabético (sin distinguir mayúsculas ni tildes).
 * Devuelve 0 solo si todo coincide: comparten posición.
 */
export function compararParticipantes(a: Participante, b: Participante): number {
  return b.puntos - a.puntos || b.exactos - a.exactos || b.aciertos - a.aciertos || nombres.compare(a.nombre, b.nombre);
}
