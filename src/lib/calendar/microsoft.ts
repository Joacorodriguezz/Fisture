// Microsoft Graph Calendar API integration

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
}

export interface MicrosoftCalendarResponse {
  id: string;
  webLink: string;
}

const GRAPH_API_BASE = "https://graph.microsoft.com/v1.0";

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

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Failed to create Microsoft Calendar event");
  }

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

  if (!response.ok && response.status !== 404) {
    const error = await response.json();
    throw new Error(error.error?.message || "Failed to delete Microsoft Calendar event");
  }
}

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
    body: JSON.stringify(event),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Failed to update Microsoft Calendar event");
  }

  return response.json();
}

export function formatMatchForMicrosoft(
  homeTeam: string,
  awayTeam: string,
  league: string,
  dateTime: Date,
  venue?: string | null
): MicrosoftCalendarEvent {
  const endTime = new Date(dateTime);
  endTime.setHours(endTime.getHours() + 2);

  // Microsoft Graph API requires specific datetime format without Z
  const formatDateTime = (d: Date) => d.toISOString().slice(0, -1);

  return {
    subject: `${homeTeam} vs ${awayTeam}`,
    body: {
      contentType: "text",
      content: `${league}\n\nAgregado con FISTURE - Fixture Sync`,
    },
    start: {
      dateTime: formatDateTime(dateTime),
      timeZone: "Argentina Standard Time",
    },
    end: {
      dateTime: formatDateTime(endTime),
      timeZone: "Argentina Standard Time",
    },
    ...(venue && { location: { displayName: venue } }),
  };
}
