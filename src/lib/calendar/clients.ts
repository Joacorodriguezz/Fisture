// Adaptadores de cada proveedor (Google / Microsoft) a una interfaz común para sync-service.
// Acá vive la idempotencia: crear dos veces el mismo partido deja un solo evento (D1).

import type { Preferences } from "../db/preferences";
import { reminderMinutes } from "../db/preferences";
import type { getMatchDetail } from "../db/queries";
import { CalendarApiError } from "./errors";
import { fistureEventId } from "./event-id";
import { eventState, type OverlapItem } from "./event-state";
import {
  createGoogleCalendarEvent,
  deleteGoogleCalendarEvent,
  formatMatchForGoogle,
  getGoogleCalendarEvent,
  listGoogleOverlaps,
  restoreGoogleCalendarEvent,
  updateGoogleCalendarEvent,
} from "./google";
import {
  createMicrosoftCalendarEvent,
  deleteMicrosoftCalendarEvent,
  findMicrosoftEventByMatch,
  formatMatchForMicrosoft,
  listMicrosoftOverlaps,
  MATCH_PROPERTY_ID,
  updateMicrosoftCalendarEvent,
} from "./microsoft";

export type MatchDetail = NonNullable<Awaited<ReturnType<typeof getMatchDetail>>>;

export interface CalendarClient {
  // Idempotente por (usuario, partido): si el evento ya existe lo adopta y lo deja al día
  create(token: string, match: MatchDetail, prefs: Preferences, ctx: { userId: string }): Promise<string>;
  update(token: string, eventId: string, match: MatchDetail, prefs: Preferences): Promise<void>;
  remove(token: string, eventId: string): Promise<void>;
  // Eventos ajenos que se superponen con el partido
  overlaps(token: string, match: MatchDetail, ownEventId: string): Promise<OverlapItem[]>;
}

const DURACION_PARTIDO_MS = 2 * 60 * 60 * 1000;

function rangoDelPartido(match: MatchDetail): [Date, Date] {
  const inicio = new Date(match.match.dateTime);
  return [inicio, new Date(inicio.getTime() + DURACION_PARTIDO_MS)];
}

function googleEvent(m: MatchDetail, prefs: Preferences) {
  return formatMatchForGoogle(
    m.homeTeam.name,
    m.awayTeam.name,
    m.league.name,
    new Date(m.match.dateTime),
    m.match.venue,
    reminderMinutes(prefs),
    eventState(m.match.status)
  );
}

function microsoftEvent(m: MatchDetail, prefs: Preferences) {
  return formatMatchForMicrosoft(
    m.homeTeam.name,
    m.awayTeam.name,
    m.league.name,
    new Date(m.match.dateTime),
    m.match.venue,
    reminderMinutes(prefs),
    eventState(m.match.status)
  );
}

const googleClient: CalendarClient = {
  async create(token, m, prefs, { userId }) {
    const eventId = await fistureEventId(userId, m.match.id);
    const event = googleEvent(m, prefs);
    try {
      await createGoogleCalendarEvent(token, {
        ...event,
        id: eventId,
        extendedProperties: { private: { fisture: m.match.id } },
      });
    } catch (error) {
      if (!(error instanceof CalendarApiError) || error.status !== 409) throw error;

      // Ya existe un evento con nuestro id: se adopta (o se restaura si el usuario lo había borrado)
      const existente = await getGoogleCalendarEvent(token, eventId);
      if (!existente) throw error;
      if (existente.status === "cancelled") await restoreGoogleCalendarEvent(token, eventId, event);
      else await updateGoogleCalendarEvent(token, eventId, event);
    }
    return eventId;
  },
  async update(token, eventId, m, prefs) {
    await updateGoogleCalendarEvent(token, eventId, googleEvent(m, prefs));
  },
  remove: (token, eventId) => deleteGoogleCalendarEvent(token, eventId),
  overlaps(token, m, ownEventId) {
    const [desde, hasta] = rangoDelPartido(m);
    return listGoogleOverlaps(token, desde, hasta, ownEventId);
  },
};

const microsoftClient: CalendarClient = {
  async create(token, m, prefs, { userId }) {
    const event = microsoftEvent(m, prefs);

    // Graph no admite ids propios: se busca un evento nuestro etiquetado con el partido
    const existente = await findMicrosoftEventByMatch(token, m.match.id);
    if (existente) {
      await updateMicrosoftCalendarEvent(token, existente, event);
      return existente;
    }

    const creado = await createMicrosoftCalendarEvent(token, {
      ...event,
      transactionId: (await fistureEventId(userId, m.match.id)).slice(0, 40),
      singleValueExtendedProperties: [{ id: MATCH_PROPERTY_ID, value: m.match.id }],
    });
    return creado.id;
  },
  async update(token, eventId, m, prefs) {
    await updateMicrosoftCalendarEvent(token, eventId, microsoftEvent(m, prefs));
  },
  remove: (token, eventId) => deleteMicrosoftCalendarEvent(token, eventId),
  overlaps(token, m, ownEventId) {
    const [desde, hasta] = rangoDelPartido(m);
    return listMicrosoftOverlaps(token, desde, hasta, ownEventId);
  },
};

export function getClient(provider: string): CalendarClient {
  if (provider === "google") return googleClient;
  if (provider === "microsoft") return microsoftClient;
  throw new Error("Proveedor de calendario no soportado");
}
