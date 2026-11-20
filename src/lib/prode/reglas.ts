// Reglas del prode (docs/37-prode-reglas.md). Lógica pura: sin D1, sin red.

/** Goles a los 90 minutos más el adicionado (sin alargue ni penales). */
export interface Marcador {
  local: number;
  visitante: number;
}

/** Totales de un participante en el ranking. `aciertos` cuenta los marcadores con ganador o empate acertado (exactos incluidos); el extra de quién pasa no entra. */
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

// --- Quién pasa (docs/40 R1 a R5) ---

/** Equipo que pasa de ronda: el local o el visitante (en alargue o penales también). */
export type Lado = "home" | "away";

export const PUNTOS_PASA = 1;

/**
 * Equipo que pasa según un marcador: con ganador, ese equipo (se deriva); con empate, el que se
 * eligió (`pasa`), o ninguno si falta. En partido único quien gana en 90' pasa.
 */
export function ladoQuePasa(marcador: Marcador, pasa: Lado | null | undefined): Lado | null {
  if (marcador.local !== marcador.visitante) return marcador.local > marcador.visitante ? "home" : "away";
  return pasa ?? null;
}

/** +1 por acertar qué equipo pasa; sin pronóstico o sin equipo que pasó, 0. */
export function calcularExtraPasa(pasaPronostico: Lado | null, pasaReal: Lado | null): number {
  return pasaPronostico !== null && pasaPronostico === pasaReal ? PUNTOS_PASA : 0;
}

export interface PuntosDelPartido {
  marcador: number;
  extra: number;
  total: number;
}

/**
 * Puntos de un partido: el marcador a 90' (3, 1 o 0, no acumulan) más el extra por quién pasa.
 * `pasaReal` es el equipo que pasó efectivo (puntos.ts); un empate pronosticado sin `pasa` no suma el extra.
 */
export function puntosDelPartido(
  pronostico: (Marcador & { pasa?: Lado | null }) | null,
  resultado: Marcador | null,
  pasaReal: Lado | null
): PuntosDelPartido {
  const marcador = calcularPuntos(pronostico, resultado);
  const extra = pronostico && resultado ? calcularExtraPasa(ladoQuePasa(pronostico, pronostico.pasa), pasaReal) : 0;
  return { marcador, extra, total: marcador + extra };
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
