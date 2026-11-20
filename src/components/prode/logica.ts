// Lógica pura de la UI del prode (sin React ni DOM), para poder probarla en Vitest.
import { horarioArgentino } from "../../lib/prode/horario";

// Igual a GOLES_MAX de lib/prode/pronosticos.ts (no se importa: arrastraría la base al bundle del cliente)
export const GOLES_MAX = 20;

export type EstadoPartido = "abierto" | "cerrado" | "jugado";

export const ETIQUETA_ESTADO: Record<EstadoPartido, string> = {
  abierto: "Abierto",
  cerrado: "Cerrado",
  jugado: "Jugado",
};

const GENERICO = "No se pudo completar la operación. Probá de nuevo.";

// Mensaje en español para un error de la API. Nunca revela si un código de invitación existe.
export function mensajeDeError(status: number, codigo?: unknown, contexto: "pronostico" | "grupo" | "unirse" = "pronostico"): string {
  if (status === 401) return "Tu sesión venció. Volvé a iniciar sesión.";
  if (status === 429) return "Demasiados intentos. Esperá un minuto.";
  if (codigo === "pronostico_cerrado") return "Cerró el pronóstico";
  if (codigo === "marcador_invalido") return `Ingresá goles enteros entre 0 y ${GOLES_MAX}.`;
  if (codigo === "partido_inexistente") return "Ese partido ya no está disponible.";
  if (codigo === "limite_de_grupos") return "Llegaste al máximo de grupos que podés crear.";
  if (contexto === "unirse") return "La invitación no es válida. Pedí un enlace nuevo a quien te invitó.";
  // El API de grupos devuelve su propio texto en español en 400; un código técnico no se muestra
  if (typeof codigo === "string" && /\s/.test(codigo)) return codigo;
  return GENERICO;
}

// "Dom 22/11 21:00 hs" (hora argentina) a partir del instante de cierre en ISO
export function formatearCierre(iso: string): string {
  const fecha = new Date(iso);
  if (Number.isNaN(fecha.getTime())) return "";
  const h = horarioArgentino(fecha);
  return `${h.fecha} ${h.hora} hs`;
}

// Un campo vacío es "sin completar"; fuera de rango o no entero es inválido (null)
export function parsearGol(texto: string): number | null {
  const t = texto.trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n <= GOLES_MAX ? n : null;
}

export function enlaceInvitacion(origen: string, codigo: string): string {
  return `${origen.replace(/\/$/, "")}/prode/unirse/${encodeURIComponent(codigo)}`;
}

export interface FilaRanking {
  posicion: number;
  nombre: string;
  puntos: number;
  exactos?: number;
  esVos: boolean;
}

function normalizarFila(f: unknown): FilaRanking | null {
  if (!f || typeof f !== "object") return null;
  const { posicion, nombre, puntos, exactos, esVos } = f as Record<string, unknown>;
  if (typeof posicion !== "number" || typeof nombre !== "string" || typeof puntos !== "number") return null;
  return { posicion, nombre, puntos, ...(typeof exactos === "number" ? { exactos } : {}), esVos: esVos === true };
}

// Acepta { filas: [...] } y descarta lo que no tenga forma de fila, sin tirar errores
export function normalizarRanking(datos: unknown): FilaRanking[] {
  const filas = (datos as { filas?: unknown } | null)?.filas;
  if (!Array.isArray(filas)) return [];
  return filas.flatMap((f) => normalizarFila(f) ?? []);
}

export interface RespuestaRanking {
  filas: FilaRanking[];
  /** Participantes del ranking completo (la API recorta las filas a 100). */
  total: number;
  /** Fila propia según la API; puede estar fuera de `filas`. */
  yo: FilaRanking | null;
}

// Lee { filas, total, yo }; sin total válido usa la cantidad de filas
export function normalizarRespuestaRanking(datos: unknown): RespuestaRanking {
  const filas = normalizarRanking(datos);
  const crudo = (datos ?? {}) as { total?: unknown; yo?: unknown };
  const total = typeof crudo.total === "number" && Number.isFinite(crudo.total) ? crudo.total : filas.length;
  return { filas, total, yo: normalizarFila(crudo.yo) };
}

// La fila propia se muestra aparte solo si la API la mandó y no está entre las visibles
export function filaPropiaAparte(filas: FilaRanking[], yo: FilaRanking | null): FilaRanking | null {
  if (!yo || filas.some((f) => f.esVos)) return null;
  return yo;
}
