// Google Calendar API integration

export interface GoogleCalendarEvent {
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

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Failed to create Google Calendar event");
  }

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

  if (!response.ok && response.status !== 404) {
    const error = await response.json();
    throw new Error(error.error?.message || "Failed to delete Google Calendar event");
  }
}

export async function updateGoogleCalendarEvent(
  accessToken: string,
  eventId: string,
  event: GoogleCalendarEvent
): Promise<GoogleCalendarResponse> {
  const response = await fetch(
    `${CALENDAR_API_BASE}/calendars/primary/events/${eventId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    }
  );

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || "Failed to update Google Calendar event");
  }

  return response.json();
}

export function formatMatchForGoogle(
  homeTeam: string,
  awayTeam: string,
  league: string,
  dateTime: Date,
  venue: string | null | undefined,
  reminderMinutes: number[]
): GoogleCalendarEvent {
  const endTime = new Date(dateTime);
  endTime.setHours(endTime.getHours() + 2); // Duración estimada: 2 horas

  return {
    summary: `${homeTeam} vs ${awayTeam}`,
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
