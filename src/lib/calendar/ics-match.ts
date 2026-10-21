// Arma el evento .ics de un partido. El UID estable y el SEQUENCE creciente hacen que, al reimportar el
// archivo, Apple Calendar actualice el evento en lugar de duplicarlo (A7, D14).

import type { CalendarEvent } from "./ics";
import { eventState, matchTitle } from "./event-state";

const DURACION_PARTIDO_MS = 2 * 60 * 60 * 1000;

export interface IcsMatch {
  id: string;
  dateTime: Date;
  venue: string | null;
  status: string | null;
  updatedAt: Date | null;
}

export function matchToIcsEvent(match: IcsMatch, home: string, away: string, league: string): CalendarEvent {
  const state = eventState(match.status);
  const startTime = new Date(match.dateTime);

  return {
    id: match.id,
    title: matchTitle(home, away, state),
    description: `${league}\n\nGenerado con FISTURE`,
    location: match.venue || undefined,
    startTime,
    endTime: new Date(startTime.getTime() + DURACION_PARTIDO_MS),
    status: state === "cancelled" ? "CANCELLED" : "CONFIRMED",
    // Segundos de updated_at: crece con cada cambio del partido y es igual entre descargas sin cambios
    sequence: match.updatedAt ? Math.floor(match.updatedAt.getTime() / 1000) : undefined,
    lastModified: match.updatedAt ?? undefined,
  };
}
