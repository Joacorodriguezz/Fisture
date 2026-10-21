// Google Calendar API integration

import { throwIfNotOk } from "./errors";
import { matchTitle, MAX_OVERLAPS, type EventState, type OverlapItem } from "./event-state";

export interface GoogleCalendarEvent {
  // Id elegido por nosotros al crear (idempotencia, ver event-id.ts)
  id?: string;
  summary: string;
  description?: string;
  location?: string;
  start: {
    dateTime: string;
    timeZone: string;
  };
  end: {
    dateTime: string;
    timeZone: string;
  };
  reminders?: {
    useDefault: boolean;
    overrides?: { method: "popup" | "email"; minutes: number }[];
  };
  extendedProperties?: { private: Record<string, string> };
}

export interface GoogleCalendarResponse {
  id: string;
  htmlLink: string;
}

const CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

export async function createGoogleCalendarEvent(
  accessToken: string,
  event: GoogleCalendarEvent
): Promise<GoogleCalendarResponse> {
  const response = await fetch(
    `${CALENDAR_API_BASE}/calendars/primary/events`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );

  await throwIfNotOk(response, "Failed to create Google Calendar event");
  return response.json();
}

export async function deleteGoogleCalendarEvent(
  accessToken: string,
  eventId: string
): Promise<void> {
  const response = await fetch(
    `${CALENDAR_API_BASE}/calendars/primary/events/${eventId}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  // 404 y 410: el evento ya no existe, que es lo que queríamos
  if (response.status === 404 || response.status === 410) return;
  await throwIfNotOk(response, "Failed to delete Google Calendar event");
}

// Campos que FISTURE controla en un evento ya creado. Quedan afuera descripción y recordatorios:
// son del usuario desde que se creó el evento (D3).
function camposPropios(event: GoogleCalendarEvent) {
  return {
    summary: event.summary,
    start: event.start,
    end: event.end,
    location: event.location,
  };
}

// PATCH (no PUT): conserva lo que el usuario cambió en su calendario
export async function updateGoogleCalendarEvent(
  accessToken: string,
  eventId: string,
  event: GoogleCalendarEvent
): Promise<GoogleCalendarResponse> {
  return patchEvent(accessToken, eventId, camposPropios(event), "Failed to update Google Calendar event");
}

// Un evento borrado queda como "cancelled" con el mismo id: se lo vuelve a confirmar
export async function restoreGoogleCalendarEvent(
  accessToken: string,
  eventId: string,
  event: GoogleCalendarEvent
): Promise<GoogleCalendarResponse> {
  return patchEvent(
    accessToken,
    eventId,
    { ...camposPropios(event), status: "confirmed" },
    "Failed to restore Google Calendar event"
  );
}

async function patchEvent(accessToken: string, eventId: string, body: object, fallback: string) {
  const response = await fetch(
    `${CALENDAR_API_BASE}/calendars/primary/events/${eventId}`,
    {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  await throwIfNotOk(response, fallback);
  return response.json() as Promise<GoogleCalendarResponse>;
}

// null si el evento no existe
export async function getGoogleCalendarEvent(
  accessToken: string,
  eventId: string
): Promise<{ id: string; status: string } | null> {
  const response = await fetch(`${CALENDAR_API_BASE}/calendars/primary/events/${eventId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 404) return null;
  await throwIfNotOk(response, "Failed to read Google Calendar event");
  const event = (await response.json()) as { id: string; status?: string };
  return { id: event.id, status: event.status ?? "confirmed" };
}

// Eventos ajenos que se superponen con el rango (no incluye el propio, cancelados ni los de todo el día)
export async function listGoogleOverlaps(
  accessToken: string,
  from: Date,
  to: Date,
  ownEventId: string
): Promise<OverlapItem[]> {
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    maxResults: "10",
  });
  const response = await fetch(`${CALENDAR_API_BASE}/calendars/primary/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await throwIfNotOk(response, "Failed to list Google Calendar events");

  const { items = [] } = (await response.json()) as {
    items?: {
      id: string;
      status?: string;
      summary?: string;
      start?: { dateTime?: string };
      end?: { dateTime?: string };
    }[];
  };

  return items
    .filter((e) => e.id !== ownEventId && e.status !== "cancelled" && e.start?.dateTime && e.end?.dateTime)
    .slice(0, MAX_OVERLAPS)
    .map((e) => ({ title: e.summary ?? "(sin título)", start: e.start!.dateTime!, end: e.end!.dateTime! }));
}

export function formatMatchForGoogle(
  homeTeam: string,
  awayTeam: string,
  league: string,
  dateTime: Date,
  venue: string | null | undefined,
  reminderMinutes: number[],
  state: EventState = "scheduled"
): GoogleCalendarEvent {
  const endTime = new Date(dateTime);
  endTime.setHours(endTime.getHours() + 2); // Duración estimada: 2 horas

  return {
    summary: matchTitle(homeTeam, awayTeam, state),
    description: `${league}\n\nAgregado con FISTURE - Fixture Sync`,
    location: venue || undefined,
    start: {
      dateTime: dateTime.toISOString(),
      timeZone: "America/Argentina/Buenos_Aires",
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: "America/Argentina/Buenos_Aires",
    },
    reminders: {
      useDefault: false,
      overrides: reminderMinutes.map((minutes) => ({ method: "popup", minutes })),
    },
  };
}
