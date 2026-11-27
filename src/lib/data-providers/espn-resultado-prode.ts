// Resultado para el prode desde ESPN (docs/40 D1): marcador a 90' y equipo que pasó.
// Función pura y conservadora: solo estados conocidos producen un dato; nunca se completa
// un dato faltante con una suposición.

import type { ProviderMatch } from "./types";

export interface CompetidorEspnProde {
  homeAway?: "home" | "away";
  score?: string;
  winner?: boolean;
  shootoutScore?: number;
  team?: { id?: string };
  linescores?: { displayValue?: string; value?: number }[];
}

export interface EventoEspnProde {
  status: { type: { name: string; state: string } };
  competitions: { competitors?: CompetidorEspnProde[]; leg?: { value?: number } }[];
}

// Respuesta de `summary?event=` (solo lo que se lee)
export interface ResumenEspn {
  header?: {
    competitions?: {
      status?: { type?: { name?: string; state?: string } };
      competitors?: CompetidorEspnProde[];
    }[];
  };
}

export type ResultadoProde = Pick<ProviderMatch, "goles90" | "pasa"> & {
  goles90: NonNullable<ProviderMatch["goles90"]> | null;
  pasa: "home" | "away" | null;
};

const NULO: ResultadoProde = { goles90: null, pasa: null };
const MAX_GOLES = 20;
const FIN_REGLAMENTARIO = "STATUS_FULL_TIME";
const ALARGUE = "STATUS_FINAL_AET";
const PENALES = "STATUS_FINAL_PEN";

function entero(valor: unknown): number | null {
  const n = typeof valor === "number" ? valor : typeof valor === "string" && /^\d+$/.test(valor.trim()) ? Number(valor) : NaN;
  return Number.isInteger(n) && n >= 0 && n <= MAX_GOLES ? n : null;
}

function lados(competidores: CompetidorEspnProde[] | undefined) {
  const local = competidores?.filter((c) => c.homeAway === "home") ?? [];
  const visitante = competidores?.filter((c) => c.homeAway === "away") ?? [];
  if (competidores?.length !== 2 || local.length !== 1 || visitante.length !== 1) return null;
  return { local: local[0], visitante: visitante[0] };
}

function ladoGanador(local: number, visitante: number): "home" | "away" | null {
  return local > visitante ? "home" : local < visitante ? "away" : null;
}

// Goles a 90' de un resumen: suma de los períodos 1 y 2, válida solo si los períodos de juego
// (1 a 4, sin la tanda) suman el marcador final de cada equipo
function goles90Resumen(
  nombre: string,
  score: { local: number; visitante: number },
  local: CompetidorEspnProde,
  visitante: CompetidorEspnProde,
  resumen: ResumenEspn | undefined,
): { local: number; visitante: number } | null {
  const comp = resumen?.header?.competitions?.[0];
  if (comp?.status?.type?.name !== nombre || comp.status.type.state !== "post") return null;
  const l = lados(comp.competitors);
  if (!l) return null;
  // Mismo equipo en ambos lados (cuando los dos traen id) y mismo marcador que el scoreboard
  for (const [a, b] of [[local, l.local], [visitante, l.visitante]] as const) {
    if (a.team?.id !== undefined && b.team?.id !== undefined && a.team.id !== b.team.id) return null;
  }
  if (entero(l.local.score) !== score.local || entero(l.visitante.score) !== score.visitante) return null;

  const periodos = (c: CompetidorEspnProde): number[] | null => {
    const ls = c.linescores;
    // AET: exactamente 4 períodos; PEN: 4 de juego y después la tanda (no se usa)
    if (!ls || ls.length < 4 || (nombre === ALARGUE && ls.length !== 4)) return null;
    const n = ls.slice(0, 4).map((p) => entero(p.displayValue ?? p.value));
    return n.every((x) => x !== null) ? (n as number[]) : null;
  };
  const pl = periodos(l.local);
  const pv = periodos(l.visitante);
  if (!pl || !pv) return null;
  const suma = (p: number[]) => p.reduce((a, b) => a + b, 0);
  if (suma(pl) !== score.local || suma(pv) !== score.visitante) return null;
  return { local: pl[0] + pl[1], visitante: pv[0] + pv[1] };
}

export function resultadoProde(evento: EventoEspnProde, resumen?: ResumenEspn): ResultadoProde {
  const nombre = evento.status?.type?.name;
  if (evento.status?.type?.state !== "post") return NULO;
  if (nombre !== FIN_REGLAMENTARIO && nombre !== ALARGUE && nombre !== PENALES) return NULO;

  const comp = evento.competitions?.[0];
  if (!comp || comp.leg !== undefined) return NULO;
  const l = lados(comp.competitors);
  if (!l) return NULO;
  const sl = entero(l.local.score);
  const sv = entero(l.visitante.score);
  if (sl === null || sv === null) return NULO;

  // Regla A: el marcador final es el de los 90'
  if (nombre === FIN_REGLAMENTARIO) {
    return { goles90: { local: sl, visitante: sv, regla: "A" }, pasa: ladoGanador(sl, sv) };
  }

  // Regla B: pasa sale del ganador que marca ESPN, verificado contra el marcador o la tanda
  const ganadores = [l.local, l.visitante].filter((c) => c.winner === true);
  let pasa: "home" | "away" | null = null;
  if (ganadores.length === 1) {
    const candidato = ganadores[0] === l.local ? "home" : "away";
    if (nombre === ALARGUE) {
      if (ladoGanador(sl, sv) === candidato) pasa = candidato;
    } else if (sl === sv) {
      const tl = entero(l.local.shootoutScore);
      const tv = entero(l.visitante.shootoutScore);
      if (tl !== null && tv !== null && ladoGanador(tl, tv) === candidato) pasa = candidato;
    }
  }
  // En penales el marcador de juego queda empatado; si no lo está, el evento es dudoso
  if (nombre === PENALES && sl !== sv) return NULO;

  const g = goles90Resumen(nombre, { local: sl, visitante: sv }, l.local, l.visitante, resumen);
  const goles90 = g ? { ...g, regla: "B" as const } : null;

  // Coherencia: si los 90' tienen ganador, pasa no puede ser el otro lado
  if (goles90 && pasa) {
    const gan = ladoGanador(goles90.local, goles90.visitante);
    if (gan && gan !== pasa) return NULO;
  }
  return { goles90, pasa };
}
