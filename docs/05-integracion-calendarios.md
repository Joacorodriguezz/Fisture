# Integración de Calendarios - FISTURE

> **Nota:** el código de este documento es el diseño inicial y quedó desactualizado. La implementación vigente está en `src/lib/calendar/` (`sync-service.ts`, `clients.ts`, `google.ts`, `microsoft.ts`, `ics-match.ts`). El comportamiento ante eventos que ya existen, reprogramaciones, postergados y cancelados (idempotencia, estados `detached` y `cancelled`, reconciliación diaria) está en [`docs/11-calendario-casos-borde-tdd.md`](11-calendario-casos-borde-tdd.md).

## Providers Soportados

| Provider | Método | Sync Automático |
|----------|--------|-----------------|
| Google Calendar | API REST | Sí |
| Microsoft Outlook | Graph API | Sí |
| Apple Calendar | Archivo .ics | No (manual) |

## 1. Google Calendar

### Crear Evento

```typescript
// src/lib/calendar/google.ts
import { getValidAccessToken } from "../auth/tokens"

interface CalendarEvent {
  matchId: string
  homeTeam: string
  awayTeam: string
  dateTime: Date
  venue?: string
  league: string
  round?: string
}

export async function createGoogleCalendarEvent(
  env: Env,
  userId: string,
  event: CalendarEvent
): Promise<string> {
  const accessToken = await getValidAccessToken(env, userId)
  if (!accessToken) throw new Error("No valid access token")

  const endTime = new Date(event.dateTime.getTime() + 2 * 60 * 60 * 1000) // +2 horas

  const googleEvent = {
    summary: `${event.homeTeam} vs ${event.awayTeam}`,
    description: `${event.league}${event.round ? ` - ${event.round}` : ""}\n\nAgregado por FISTURE`,
    location: event.venue,
    start: {
      dateTime: event.dateTime.toISOString(),
      timeZone: "America/Argentina/Buenos_Aires",
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: "America/Argentina/Buenos_Aires",
    },
    reminders: {
      useDefault: false,
      overrides: [
        { method: "popup", minutes: 60 },
        { method: "popup", minutes: 15 },
      ],
    },
  }

  const response = await fetch(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(googleEvent),
    }
  )

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Google Calendar API error: ${error}`)
  }

  const result = await response.json()
  return result.id
}

export async function updateGoogleCalendarEvent(
  env: Env,
  userId: string,
  eventId: string,
  event: CalendarEvent
): Promise<void> {
  const accessToken = await getValidAccessToken(env, userId)
  if (!accessToken) throw new Error("No valid access token")

  const endTime = new Date(event.dateTime.getTime() + 2 * 60 * 60 * 1000)

  const googleEvent = {
    summary: `${event.homeTeam} vs ${event.awayTeam}`,
    description: `${event.league}${event.round ? ` - ${event.round}` : ""}\n\nAgregado por FISTURE`,
    location: event.venue,
    start: {
      dateTime: event.dateTime.toISOString(),
      timeZone: "America/Argentina/Buenos_Aires",
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: "America/Argentina/Buenos_Aires",
    },
  }

  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(googleEvent),
    }
  )

  if (!response.ok) {
    throw new Error(`Failed to update Google Calendar event`)
  }
}

export async function deleteGoogleCalendarEvent(
  env: Env,
  userId: string,
  eventId: string
): Promise<void> {
  const accessToken = await getValidAccessToken(env, userId)
  if (!accessToken) throw new Error("No valid access token")

  await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  )
}
```

## 2. Microsoft Outlook

### Crear Evento

```typescript
// src/lib/calendar/microsoft.ts
import { getValidAccessToken } from "../auth/tokens"

export async function createOutlookCalendarEvent(
  env: Env,
  userId: string,
  event: CalendarEvent
): Promise<string> {
  const accessToken = await getValidAccessToken(env, userId)
  if (!accessToken) throw new Error("No valid access token")

  const endTime = new Date(event.dateTime.getTime() + 2 * 60 * 60 * 1000)

  const outlookEvent = {
    subject: `${event.homeTeam} vs ${event.awayTeam}`,
    body: {
      contentType: "HTML",
      content: `<p><strong>${event.league}</strong>${event.round ? ` - ${event.round}` : ""}</p><p>Agregado por FISTURE</p>`,
    },
    start: {
      dateTime: event.dateTime.toISOString(),
      timeZone: "Argentina Standard Time",
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: "Argentina Standard Time",
    },
    location: event.venue ? { displayName: event.venue } : undefined,
    reminderMinutesBeforeStart: 60,
    isReminderOn: true,
  }

  const response = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(outlookEvent),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Microsoft Graph API error: ${error}`)
  }

  const result = await response.json()
  return result.id
}

export async function updateOutlookCalendarEvent(
  env: Env,
  userId: string,
  eventId: string,
  event: CalendarEvent
): Promise<void> {
  const accessToken = await getValidAccessToken(env, userId)
  if (!accessToken) throw new Error("No valid access token")

  const endTime = new Date(event.dateTime.getTime() + 2 * 60 * 60 * 1000)

  const outlookEvent = {
    subject: `${event.homeTeam} vs ${event.awayTeam}`,
    start: {
      dateTime: event.dateTime.toISOString(),
      timeZone: "Argentina Standard Time",
    },
    end: {
      dateTime: endTime.toISOString(),
      timeZone: "Argentina Standard Time",
    },
    location: event.venue ? { displayName: event.venue } : undefined,
  }

  await fetch(`https://graph.microsoft.com/v1.0/me/events/${eventId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(outlookEvent),
  })
}

export async function deleteOutlookCalendarEvent(
  env: Env,
  userId: string,
  eventId: string
): Promise<void> {
  const accessToken = await getValidAccessToken(env, userId)
  if (!accessToken) throw new Error("No valid access token")

  await fetch(`https://graph.microsoft.com/v1.0/me/events/${eventId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}
```

## 3. Apple Calendar (.ics)

Apple no tiene API de calendario accesible. Generamos archivo .ics que el usuario descarga.

```typescript
// src/lib/calendar/ics.ts

interface ICSEvent {
  id: string
  homeTeam: string
  awayTeam: string
  dateTime: Date
  venue?: string
  league: string
  round?: string
}

export function generateICS(events: ICSEvent[]): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FISTURE//Partidos//ES",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:FISTURE - Partidos",
    "X-WR-TIMEZONE:America/Argentina/Buenos_Aires",
  ]

  for (const event of events) {
    const endTime = new Date(event.dateTime.getTime() + 2 * 60 * 60 * 1000)

    lines.push(
      "BEGIN:VEVENT",
      `UID:fisture-${event.id}@fisture.app`,
      `DTSTAMP:${formatICSDate(new Date())}`,
      `DTSTART:${formatICSDate(event.dateTime)}`,
      `DTEND:${formatICSDate(endTime)}`,
      `SUMMARY:${event.homeTeam} vs ${event.awayTeam}`,
      `DESCRIPTION:${event.league}${event.round ? ` - ${event.round}` : ""}\\n\\nAgregado por FISTURE`,
      ...(event.venue ? [`LOCATION:${event.venue}`] : []),
      "BEGIN:VALARM",
      "TRIGGER:-PT1H",
      "ACTION:DISPLAY",
      "DESCRIPTION:Partido en 1 hora",
      "END:VALARM",
      "BEGIN:VALARM",
      "TRIGGER:-PT15M",
      "ACTION:DISPLAY",
      "DESCRIPTION:Partido en 15 minutos",
      "END:VALARM",
      "END:VEVENT"
    )
  }

  lines.push("END:VCALENDAR")

  return lines.join("\r\n")
}

function formatICSDate(date: Date): string {
  return date.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z"
}
```

### Endpoint de Descarga

```typescript
// src/pages/api/calendario/download.ts
import type { APIRoute } from "astro"
import { generateICS } from "../../../lib/calendar/ics"
import { createDb } from "../../../lib/db"
import { getUpcomingMatches } from "../../../lib/db/queries"

export const GET: APIRoute = async ({ locals, url }) => {
  const user = locals.user
  if (!user) {
    return new Response("Unauthorized", { status: 401 })
  }

  const env = locals.runtime.env
  const db = createDb(env.DB)

  // Obtener partidos
  const teamId = url.searchParams.get("teamId")
  const matches = await getUpcomingMatches(db, user.id, 50)

  // Filtrar por equipo si se especifica
  const filteredMatches = teamId
    ? matches.filter(m => m.match.homeTeamId === teamId || m.match.awayTeamId === teamId)
    : matches

  // Convertir a formato ICS
  const events = filteredMatches.map(m => ({
    id: m.match.id,
    homeTeam: m.homeTeam.name,
    awayTeam: m.awayTeam.name,
    dateTime: new Date(m.match.dateTime),
    venue: m.match.venue || undefined,
    league: m.league.name,
    round: m.match.round || undefined,
  }))

  const icsContent = generateICS(events)

  return new Response(icsContent, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="fisture-partidos.ics"',
    },
  })
}
```

## Servicio Unificado de Calendario

```typescript
// src/lib/calendar/service.ts
import { createDb } from "../db"
import { calendarSyncs, matches, teams } from "../../../drizzle/schema"
import { eq, and } from "drizzle-orm"
import { createGoogleCalendarEvent, updateGoogleCalendarEvent, deleteGoogleCalendarEvent } from "./google"
import { createOutlookCalendarEvent, updateOutlookCalendarEvent, deleteOutlookCalendarEvent } from "./microsoft"

interface SyncMatchResult {
  success: boolean
  eventId?: string
  error?: string
}

export async function syncMatchToCalendar(
  env: Env,
  userId: string,
  matchId: string,
  provider: "google" | "microsoft"
): Promise<SyncMatchResult> {
  const db = createDb(env.DB)

  // Obtener match con equipos
  const match = await db.query.matches.findFirst({
    where: eq(matches.id, matchId),
    with: {
      homeTeam: true,
      awayTeam: true,
      league: true,
    },
  })

  if (!match) {
    return { success: false, error: "Match not found" }
  }

  // Verificar si ya existe sync
  const existingSync = await db.query.calendarSyncs.findFirst({
    where: and(
      eq(calendarSyncs.userId, userId),
      eq(calendarSyncs.matchId, matchId),
      eq(calendarSyncs.provider, provider)
    ),
  })

  const eventData = {
    matchId: match.id,
    homeTeam: match.homeTeam.name,
    awayTeam: match.awayTeam.name,
    dateTime: new Date(match.dateTime),
    venue: match.venue || undefined,
    league: match.league.name,
    round: match.round || undefined,
  }

  try {
    let eventId: string

    if (existingSync?.externalEventId) {
      // Actualizar evento existente
      if (provider === "google") {
        await updateGoogleCalendarEvent(env, userId, existingSync.externalEventId, eventData)
      } else {
        await updateOutlookCalendarEvent(env, userId, existingSync.externalEventId, eventData)
      }
      eventId = existingSync.externalEventId
    } else {
      // Crear nuevo evento
      if (provider === "google") {
        eventId = await createGoogleCalendarEvent(env, userId, eventData)
      } else {
        eventId = await createOutlookCalendarEvent(env, userId, eventData)
      }
    }

    // Guardar/actualizar sync en DB
    if (existingSync) {
      await db
        .update(calendarSyncs)
        .set({
          externalEventId: eventId,
          status: "synced",
          lastSyncedAt: new Date(),
          errorMessage: null,
        })
        .where(eq(calendarSyncs.id, existingSync.id))
    } else {
      await db.insert(calendarSyncs).values({
        userId,
        matchId,
        provider,
        externalEventId: eventId,
        status: "synced",
        lastSyncedAt: new Date(),
      })
    }

    return { success: true, eventId }
  } catch (error) {
    // Guardar error
    if (existingSync) {
      await db
        .update(calendarSyncs)
        .set({
          status: "failed",
          errorMessage: error instanceof Error ? error.message : "Unknown error",
        })
        .where(eq(calendarSyncs.id, existingSync.id))
    }

    return { success: false, error: error instanceof Error ? error.message : "Unknown error" }
  }
}

export async function removeMatchFromCalendar(
  env: Env,
  userId: string,
  matchId: string
): Promise<void> {
  const db = createDb(env.DB)

  const sync = await db.query.calendarSyncs.findFirst({
    where: and(
      eq(calendarSyncs.userId, userId),
      eq(calendarSyncs.matchId, matchId)
    ),
  })

  if (sync?.externalEventId) {
    try {
      if (sync.provider === "google") {
        await deleteGoogleCalendarEvent(env, userId, sync.externalEventId)
      } else if (sync.provider === "microsoft") {
        await deleteOutlookCalendarEvent(env, userId, sync.externalEventId)
      }
    } catch (error) {
      console.error("Failed to delete calendar event:", error)
    }
  }

  await db.delete(calendarSyncs).where(
    and(
      eq(calendarSyncs.userId, userId),
      eq(calendarSyncs.matchId, matchId)
    )
  )
}
```

## API Endpoint para Sync

```typescript
// src/pages/api/calendario/sync.ts
import type { APIRoute } from "astro"
import { syncMatchToCalendar } from "../../../lib/calendar/service"

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
  }

  const { matchId } = await request.json()
  if (!matchId) {
    return new Response(JSON.stringify({ error: "matchId required" }), { status: 400 })
  }

  const env = locals.runtime.env
  const provider = user.provider === "microsoft" ? "microsoft" : "google"

  const result = await syncMatchToCalendar(env, user.id, matchId, provider)

  if (result.success) {
    return new Response(JSON.stringify({ success: true, eventId: result.eventId }))
  } else {
    return new Response(JSON.stringify({ success: false, error: result.error }), { status: 500 })
  }
}
```

## Componente de Botón de Calendario

```tsx
// src/components/islands/CalendarButton.tsx
import { useState } from "react"

interface CalendarButtonProps {
  matchId: string
  isSynced?: boolean
  provider?: string
}

export default function CalendarButton({ matchId, isSynced = false, provider }: CalendarButtonProps) {
  const [syncing, setSyncing] = useState(false)
  const [synced, setSynced] = useState(isSynced)

  const handleSync = async () => {
    if (synced || syncing) return

    setSyncing(true)

    try {
      const res = await fetch("/api/calendario/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      })

      if (res.ok) {
        setSynced(true)
      }
    } catch (error) {
      console.error("Sync failed:", error)
    } finally {
      setSyncing(false)
    }
  }

  // Para Apple, mostrar botón de descarga
  if (provider === "apple") {
    return (
      <a
        href={`/api/calendario/download?matchId=${matchId}`}
        class="btn btn-primary"
        download
      >
        Descargar .ics
      </a>
    )
  }

  return (
    <button
      onClick={handleSync}
      disabled={syncing || synced}
      class={`btn ${synced ? "btn-success" : "btn-primary"}`}
    >
      {syncing ? "Agregando..." : synced ? "En calendario" : "Agregar"}
    </button>
  )
}
```

## Resumen de Limitaciones

| Provider | Crear | Actualizar | Eliminar | Auto-sync |
|----------|-------|------------|----------|-----------|
| Google | API | API | API | Sí |
| Microsoft | API | API | API | Sí |
| Apple | .ics | Manual | Manual | No |
