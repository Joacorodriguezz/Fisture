// Microsoft Graph Calendar API integration

import { throwIfNotOk } from "./errors";
import { matchTitle, MAX_OVERLAPS, type EventState, type OverlapItem } from "./event-state";

export interface MicrosoftCalendarEvent {
  subject: string;
  body?: {
    contentType: "text" | "html";
    content: string;
  };
  start: {
    dateTime: string;
    timeZone: string;
  };
  end: {
    dateTime: string;
    timeZone: string;
  };
  location?: {
    displayName: string;
  };
  isReminderOn: boolean;
  reminderMinutesBeforeStart: number;
  // Graph evita POST repetidos con el mismo transactionId (reintentos)
  transactionId?: string;
  // Etiqueta con el matchId, para reencontrar el evento si se pierde la fila
  singleValueExtendedProperties?: { id: string; value: string }[];
}

export interface MicrosoftCalendarResponse {
  id: string;
  webLink: string;
}

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

// Propiedad extendida (espacio de nombres público) donde guardamos el matchId
export const MATCH_PROPERTY_ID = "String {00020329-0000-0000-C000-000000000046} Name fisture.matchId";

export async function createMicrosoftCalendarEvent(
  accessToken: string,
  event: MicrosoftCalendarEvent
): Promise<MicrosoftCalendarResponse> {
  const response = await fetch(`${GRAPH_API_BASE}/me/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(event),
  });

  await throwIfNotOk(response, "Failed to create Microsoft Calendar event");
  return response.json();
}

export async function deleteMicrosoftCalendarEvent(
  accessToken: string,
  eventId: string
): Promise<void> {
  const response = await fetch(`${GRAPH_API_BASE}/me/events/${eventId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (response.status === 404) return;
  await throwIfNotOk(response, "Failed to delete Microsoft Calendar event");
}

// PATCH solo con los campos que FISTURE controla: el cuerpo y el recordatorio son del usuario (D3)
export async function updateMicrosoftCalendarEvent(
  accessToken: string,
  eventId: string,
  event: MicrosoftCalendarEvent
): Promise<MicrosoftCalendarResponse> {
  const response = await fetch(`${GRAPH_API_BASE}/me/events/${eventId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      subject: event.subject,
      start: event.start,
      end: event.end,
      location: event.location,
    }),
  });

  await throwIfNotOk(response, "Failed to update Microsoft Calendar event");
  return response.json();
}

// Id del evento que FISTURE creó para ese partido, o null si no está
export async function findMicrosoftEventByMatch(accessToken: string, matchId: string): Promise<string | null> {
  const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${MATCH_PROPERTY_ID}' and ep/value eq '${matchId}')`;
  const params = new URLSearchParams({ $filter: filter, $select: "id", $top: "1" });
  const response = await fetch(`${GRAPH_API_BASE}/me/events?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  await throwIfNotOk(response, "Failed to search Microsoft Calendar events");
  const { value = [] } = (await response.json()) as { value?: { id: string }[] };
  return value[0]?.id ?? null;
}

// Eventos ajenos que se superponen con el rango (no incluye el propio, cancelados ni los de todo el día)
export async function listMicrosoftOverlaps(
  accessToken: string,
  from: Date,
  to: Date,
  ownEventId: string
): Promise<OverlapItem[]> {
  const params = new URLSearchParams({
    startDateTime: from.toISOString(),
    endDateTime: to.toISOString(),
    $select: "id,subject,start,end,isAllDay,isCancelled",
    $top: "10",
  });
  const response = await fetch(`${GRAPH_API_BASE}/me/calendarView?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Prefer: 'outlook.timezone="UTC"' },
  });
  await throwIfNotOk(response, "Failed to list Microsoft Calendar events");

  const { value = [] } = (await response.json()) as {
    value?: {
      id: string;
      subject?: string;
      isAllDay?: boolean;
      isCancelled?: boolean;
      start: { dateTime: string };
      end: { dateTime: string };
    }[];
  };

  return value
    .filter((e) => e.id !== ownEventId && !e.isCancelled && !e.isAllDay)
    .slice(0, MAX_OVERLAPS)
    .map((e) => ({ title: e.subject ?? "(sin título)", start: `${e.start.dateTime}Z`, end: `${e.end.dateTime}Z` }));
}

export function formatMatchForMicrosoft(
  homeTeam: string,
  awayTeam: string,
  league: string,
  dateTime: Date,
  venue: string | null | undefined,
  reminderMinutes: number[],
  state: EventState = "scheduled"
): MicrosoftCalendarEvent {
  const endTime = new Date(dateTime);
  endTime.setHours(endTime.getHours() + 2);

  // Microsoft Graph API requires specific datetime format without Z
  const formatDateTime = (d: Date) => d.toISOString().slice(0, -1);

  // Graph solo admite un aviso por evento: usamos el más anticipado
  const reminder = reminderMinutes.length ? Math.max(...reminderMinutes) : 0;

  return {
    isReminderOn: reminder > 0,
    reminderMinutesBeforeStart: reminder,
    subject: matchTitle(homeTeam, awayTeam, state),
    body: {
      contentType: "text",
      content: `${league}\n\nAgregado con FISTURE - Fixture Sync`,
    },
    start: {
      dateTime: formatDateTime(dateTime),
      timeZone: "UTC",
    },
    end: {
      dateTime: formatDateTime(endTime),
      timeZone: "UTC",
    },
    ...(venue && { location: { displayName: venue } }),
  };
}
