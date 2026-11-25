// Resultado automático del prode en el sync (docs/40 D1 a D3 y §4.3): decisiones puras, sin D1 ni red.
// El sync lee el resultado de ESPN solo de los partidos adoptados del prode y lo guarda en las columnas
// `auto_*` de prode_matches. Nunca toca las manuales (home_goals_90, away_goals_90, pasa), así que no
// puede pisar una corrección. Un dato puntúa solo cuando está confirmado.

import { rootLogger, type Logger } from "../observability/logger";
import type { ProviderMatch } from "./types";

export const CLAVE_KV_RESULTADO_AUTO = "prode:resultado_auto";

// Un dato automático se confirma cuando se vio igual en dos lecturas separadas por esto, o cuando la
// primera lectura llega esto después del inicio del partido (el sync diario). docs/40 §4.3
export const CONFIRMACION_MS = 10 * 60_000;
export const PRIMERA_LECTURA_TARDIA_MS = 4 * 60 * 60_000;

export type ModoAuto = "on" | "off" | "solo-a" | "solo-b";
export type Regla = "A" | "B";
type Lado = "home" | "away";

const MODOS = new Set<string>(["on", "off", "solo-a", "solo-b"]);

/**
 * Interruptor KV `prode:resultado_auto` (docs/40 D3). Sin clave equivale a `on`. Un valor desconocido o un
 * KV caído se tratan como `off`: ante la duda no se escribe ningún dato automático. Sin KV (tests, dev) es `on`.
 */
export async function leerModoAuto(kv: { get?(key: string): Promise<string | null> } | undefined, logger: Logger = rootLogger): Promise<ModoAuto> {
  if (!kv?.get) return "on";
  let valor: string | null;
  try {
    valor = await kv.get(CLAVE_KV_RESULTADO_AUTO);
  } catch {
    logger.warn("prode_resultado_auto_kv_fallo", {});
    return "off";
  }
  if (valor === null) return "on";
  const modo = valor.trim().toLowerCase();
  if (MODOS.has(modo)) return modo as ModoAuto;
  logger.warn("prode_resultado_auto_modo_desconocido", { modo: modo.slice(0, 20) });
  return "off";
}

// Regla con que se produce el resultado según el estado crudo de ESPN (lista blanca de docs/40 D1)
export function reglaDeEstado(estado: string | undefined): Regla | null {
  if (estado === "STATUS_FULL_TIME") return "A";
  if (estado === "STATUS_FINAL_AET" || estado === "STATUS_FINAL_PEN") return "B";
  return null;
}

export function permiteRegla(modo: ModoAuto, regla: Regla | null): boolean {
  if (modo === "off") return false;
  if (modo === "on" || regla === null) return true;
  return (modo === "solo-a") === (regla === "A");
}

/** Lo que el sync propone para un partido: el resultado de ESPN, sin confirmar. */
export interface ResultadoAuto {
  local: number | null;
  visitante: number | null;
  pasa: Lado | null;
  regla: Regla | null;
}

/** Columnas automáticas de prode_matches. */
export interface ColumnasAuto {
  autoHomeGoals90: number | null;
  autoAwayGoals90: number | null;
  autoPasa: string | null;
  autoRegla: string | null;
  autoVistoAt: number | null;
  autoConfirmadoAt: number | null;
}

export const AUTO_VACIO: ColumnasAuto = {
  autoHomeGoals90: null,
  autoAwayGoals90: null,
  autoPasa: null,
  autoRegla: null,
  autoVistoAt: null,
  autoConfirmadoAt: null,
};

export const SIN_RESULTADO: ResultadoAuto = { local: null, visitante: null, pasa: null, regla: null };

export function resultadoAutoDe(m: Pick<ProviderMatch, "estadoProveedor" | "goles90" | "pasa">): ResultadoAuto {
  const pasa = m.pasa ?? null;
  return {
    local: m.goles90?.local ?? null,
    visitante: m.goles90?.visitante ?? null,
    pasa,
    regla: m.goles90?.regla ?? (pasa ? reglaDeEstado(m.estadoProveedor) : null),
  };
}

/**
 * Cambio de columnas para una lectura nueva, o null si no hay nada que escribir (docs/40 §4.3):
 * - sin dato nuevo: si había datos automáticos se vacían (la fuente ya no los respalda);
 * - dato nuevo o distinto: se reinicia la lectura (`visto`) y solo se confirma si el partido empezó hace 4 h o más;
 * - mismo dato: se confirma al repetirse 10 minutos o más después de verlo.
 */
export function cambioAuto(actual: ColumnasAuto, nuevo: ResultadoAuto, ahora: number, inicio: number): ColumnasAuto | null {
  const hayDato = nuevo.local !== null || nuevo.visitante !== null || nuevo.pasa !== null;
  const siguiente: ColumnasAuto = hayDato ? { ...AUTO_VACIO } : AUTO_VACIO;
  if (hayDato) {
    const tardia = ahora - inicio >= PRIMERA_LECTURA_TARDIA_MS;
    const igual =
      actual.autoVistoAt !== null &&
      actual.autoHomeGoals90 === nuevo.local &&
      actual.autoAwayGoals90 === nuevo.visitante &&
      actual.autoPasa === nuevo.pasa &&
      actual.autoRegla === nuevo.regla;
    const visto = igual ? actual.autoVistoAt! : ahora;
    const confirmado = igual && actual.autoConfirmadoAt !== null ? actual.autoConfirmadoAt : tardia || (igual && ahora - visto >= CONFIRMACION_MS) ? ahora : null;
    Object.assign(siguiente, {
      autoHomeGoals90: nuevo.local,
      autoAwayGoals90: nuevo.visitante,
      autoPasa: nuevo.pasa,
      autoRegla: nuevo.regla,
      autoVistoAt: visto,
      autoConfirmadoAt: confirmado,
    });
  }
  const sinCambio = (Object.keys(AUTO_VACIO) as (keyof ColumnasAuto)[]).every((k) => actual[k] === siguiente[k]);
  return sinCambio ? null : siguiente;
}

export type MotivoEspera = "equipos_no_coinciden" | "estado_desconocido" | "parciales_incompletos" | "parciales_no_cierran" | "ganador_incierto" | "inconsistente" | "sin_confirmar";

/**
 * Por qué un partido terminado del prode todavía no tiene resultado confirmado (docs/40 D5), o null si ya
 * lo tiene. `resumen`: qué pasó con el summary de ESPN (solo se pide con alargue o penales).
 */
export function motivoEnEspera(
  estado: string | undefined,
  nuevo: ResultadoAuto,
  confirmado: boolean,
  resumen: "no_pedido" | "ok" | "fallo"
): MotivoEspera | null {
  const regla = reglaDeEstado(estado);
  if (regla === null) return "estado_desconocido";
  if (nuevo.local === null || nuevo.visitante === null) {
    if (regla === "B") return resumen === "ok" ? "parciales_no_cierran" : "parciales_incompletos";
    return "inconsistente";
  }
  if (nuevo.local === nuevo.visitante && nuevo.pasa === null) return "ganador_incierto";
  return confirmado ? null : "sin_confirmar";
}
