// Estado del partido que importa para el evento del calendario (D8, D11).
// live y finished no cambian lo que se ve, así que cuentan como scheduled.

export type EventState = "scheduled" | "postponed" | "cancelled";

export function eventState(status: string | null | undefined): EventState {
  return status === "postponed" || status === "cancelled" ? status : "scheduled";
}

export function matchTitle(home: string, away: string, state: EventState = "scheduled"): string {
  const base = `${home} vs ${away}`;
  return state === "postponed" ? `[POSTERGADO] ${base}` : base;
}

export interface OverlapItem {
  title: string;
  start: string;
  end: string;
}

// Máximo de eventos ajenos que se informan al usuario (D7)
export const MAX_OVERLAPS = 3;
