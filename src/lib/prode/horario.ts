// Horario de los partidos del prode de playoffs. Una sola fuente: el instante de matches.date_time.
// Lo que se muestra (hora argentina) y lo que cierra el pronóstico salen de ese mismo valor, así un
// horario reprogramado mueve las dos cosas a la vez.
import { fechaCorta, hora } from "../format";

// Argentina no tiene horario de verano: UTC-3 fijo
const OFFSET = "-03:00";
const OFFSET_MS = 3 * 60 * 60 * 1000;

export const FASES = ["octavos", "cuartos", "semifinal", "final"] as const;
export type Fase = (typeof FASES)[number];

const ETIQUETAS: Record<Fase, string> = {
  octavos: "Octavos de final",
  cuartos: "Cuartos de final",
  semifinal: "Semifinal",
  final: "Final",
};

export function esFase(valor: unknown): valor is Fase {
  return typeof valor === "string" && (FASES as readonly string[]).includes(valor);
}

export function etiquetaFase(fase: Fase): string {
  return ETIQUETAS[fase];
}

// "2026-11-22T21:00" (hora argentina, sin zona) -> instante. Cualquier otro formato da null, para que
// la carga manual no dependa de la zona horaria de quien la hace ni del servidor.
export function parsearHorarioArgentino(valor: unknown): Date | null {
  if (typeof valor !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(valor);
  if (!m) return null;
  const [, y, mo, d, h, mi] = m.map(Number);
  if (h > 23 || mi > 59) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi);
  const fecha = new Date(local);
  // Descarta fechas que Date normaliza (30 de febrero -> 2 de marzo)
  if (fecha.getUTCFullYear() !== y || fecha.getUTCMonth() !== mo - 1 || fecha.getUTCDate() !== d) return null;
  return new Date(local + OFFSET_MS);
}

export interface HorarioMostrado {
  fecha: string; // "Dom 22/11"
  hora: string; // "21:00"
  iso: string; // "2026-11-22T21:00-03:00"
}

export function horarioArgentino(instante: Date): HorarioMostrado {
  const local = new Date(instante.getTime() - OFFSET_MS).toISOString().slice(0, 16);
  return { fecha: fechaCorta(instante), hora: hora(instante), iso: `${local}${OFFSET}` };
}

// Estados de matches.status en los que el partido sigue sin empezar. Un suspendido después de empezar
// queda en postponed con su horario ya pasado, así que el criterio de hora lo mantiene cerrado.
const ESTADOS_SIN_EMPEZAR: readonly string[] = ["scheduled", "postponed"];

export function estadoSinEmpezar(status: string | null | undefined): boolean {
  return status == null || ESTADOS_SIN_EMPEZAR.includes(status);
}

// El pronóstico cierra en el instante exacto del partido (el mismo que se muestra), o antes si el
// partido ya está en vivo, terminado o cancelado (docs/37 §5)
export function cierraPronostico(partido: { dateTime: Date | number; status?: string | null }, ahora: Date): boolean {
  if (!estadoSinEmpezar(partido.status)) return true;
  const inicio = partido.dateTime instanceof Date ? partido.dateTime.getTime() : partido.dateTime;
  return ahora.getTime() >= inicio;
}
