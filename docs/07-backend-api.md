# Backend API - FISTURE

## Arquitectura

Las APIs corren como **Astro API Routes** que se despliegan como **Cloudflare Workers**.

```
src/pages/api/
├── auth/
│   ├── login/[provider].ts    # Iniciar OAuth
│   ├── callback/[provider].ts # OAuth callback
│   └── logout.ts              # Cerrar sesión
├── equipos/
│   ├── index.ts               # GET buscar, POST agregar
│   ├── [id].ts                # GET detalle, DELETE eliminar
│   └── buscar.ts              # GET buscar equipos
├── partidos/
│   └── index.ts               # GET partidos del usuario
├── calendario/
│   ├── sync.ts                # POST sincronizar partido
│   └── download.ts            # GET descargar .ics
└── admin/
    └── sync.ts                # POST sync manual (admin)
```

## Endpoints

### GET /api/equipos/buscar

Buscar equipos por nombre.

```typescript
// src/pages/api/equipos/buscar.ts
import type { APIRoute } from "astro"
import { createDb } from "../../../lib/db"
import { searchTeams } from "../../../lib/db/queries"
import { userTeams } from "../../../../drizzle/schema"
import { eq, and } from "drizzle-orm"

export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
  }

  const query = url.searchParams.get("q")
  if (!query || query.length < 2) {
    return new Response(JSON.stringify([]))
  }

  const db = createDb(locals.runtime.env.DB)
  const results = await searchTeams(db, query, 20)

  // Agregar flag de si el usuario ya sigue el equipo
  const userTeamIds = await db
    .select({ teamId: userTeams.teamId })
    .from(userTeams)
    .where(eq(userTeams.userId, user.id))

  const followingIds = new Set(userTeamIds.map(ut => ut.teamId))

  const response = results.map(r => ({
    id: r.team.id,
    name: r.team.name,
    logo: r.team.logo,
    league: {
      id: r.league.id,
      name: r.league.name,
    },
    isFollowing: followingIds.has(r.team.id),
  }))

  return new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json" },
  })
}
```

### POST /api/equipos

Agregar equipo a favoritos.

```typescript
// src/pages/api/equipos/index.ts
import type { APIRoute } from "astro"
import { createDb } from "../../../lib/db"
import { addUserTeam } from "../../../lib/db/queries"
import { teams, matches, calendarSyncs, userTeams } from "../../../../drizzle/schema"
import { eq, and, gte, or } from "drizzle-orm"

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
  }

  const { teamId, autoSync = true } = await request.json()

  if (!teamId) {
    return new Response(JSON.stringify({ error: "teamId required" }), { status: 400 })
  }

  const db = createDb(locals.runtime.env.DB)

  // Verificar que el equipo existe
  const team = await db.query.teams.findFirst({
    where: eq(teams.id, teamId),
  })

  if (!team) {
    return new Response(JSON.stringify({ error: "Team not found" }), { status: 404 })
  }

  // Verificar que no lo sigue ya
  const existing = await db.query.userTeams.findFirst({
    where: and(
      eq(userTeams.userId, user.id),
      eq(userTeams.teamId, teamId)
    ),
  })

  if (existing) {
    return new Response(JSON.stringify({ error: "Already following" }), { status: 409 })
  }

  // Agregar equipo
  const [result] = await addUserTeam(db, user.id, teamId)

  // Si autoSync, crear CalendarSyncs pendientes para partidos futuros
  if (autoSync && user.provider !== "apple") {
    const upcomingMatches = await db
      .select()
      .from(matches)
      .where(
        and(
          or(
            eq(matches.homeTeamId, teamId),
            eq(matches.awayTeamId, teamId)
          ),
          gte(matches.dateTime, new Date()),
          eq(matches.status, "scheduled")
        )
      )

    for (const match of upcomingMatches) {
      await db.insert(calendarSyncs).values({
        userId: user.id,
        matchId: match.id,
        provider: user.provider === "microsoft" ? "microsoft" : "google",
        status: "pending",
      }).onConflictDoNothing()
    }
  }

  return new Response(JSON.stringify({ success: true, id: result.id }), { status: 201 })
}
```

### DELETE /api/equipos/[id]

Eliminar equipo de favoritos.

```typescript
// src/pages/api/equipos/[id].ts
import type { APIRoute } from "astro"
import { createDb } from "../../../lib/db"
import { removeUserTeam } from "../../../lib/db/queries"
import { removeMatchFromCalendar } from "../../../lib/calendar/service"
import { calendarSyncs, matches } from "../../../../drizzle/schema"
import { eq, and, or } from "drizzle-orm"

export const DELETE: APIRoute = async ({ params, locals }) => {
  const user = locals.user
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
  }

  const { id: teamId } = params
  if (!teamId) {
    return new Response(JSON.stringify({ error: "teamId required" }), { status: 400 })
  }

  const env = locals.runtime.env
  const db = createDb(env.DB)

  // Obtener syncs de este equipo para eliminar de calendario
  const syncs = await db
    .select({ matchId: calendarSyncs.matchId })
    .from(calendarSyncs)
    .innerJoin(matches, eq(calendarSyncs.matchId, matches.id))
    .where(
      and(
        eq(calendarSyncs.userId, user.id),
        or(
          eq(matches.homeTeamId, teamId),
          eq(matches.awayTeamId, teamId)
        )
      )
    )

  // Eliminar eventos del calendario
  for (const sync of syncs) {
    try {
      await removeMatchFromCalendar(env, user.id, sync.matchId)
    } catch (e) {
      console.error("Failed to remove calendar event:", e)
    }
  }

  // Eliminar equipo de favoritos
  await removeUserTeam(db, user.id, teamId)

  return new Response(JSON.stringify({ success: true }))
}
```

### GET /api/partidos

Obtener próximos partidos del usuario.

```typescript
// src/pages/api/partidos/index.ts
import type { APIRoute } from "astro"
import { createDb } from "../../../lib/db"
import { getUpcomingMatches } from "../../../lib/db/queries"
import { calendarSyncs } from "../../../../drizzle/schema"
import { eq, and } from "drizzle-orm"

export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
  }

  const limit = parseInt(url.searchParams.get("limit") || "20")
  const teamId = url.searchParams.get("teamId")

  const db = createDb(locals.runtime.env.DB)
  let matches = await getUpcomingMatches(db, user.id, Math.min(limit, 100))

  // Filtrar por equipo si se especifica
  if (teamId) {
    matches = matches.filter(
      m => m.match.homeTeamId === teamId || m.match.awayTeamId === teamId
    )
  }

  // Agregar estado de sync
  const matchIds = matches.map(m => m.match.id)
  const syncs = await db
    .select()
    .from(calendarSyncs)
    .where(
      and(
        eq(calendarSyncs.userId, user.id),
        inArray(calendarSyncs.matchId, matchIds)
      )
    )

  const syncMap = new Map(syncs.map(s => [s.matchId, s.status]))

  const response = matches.map(m => ({
    id: m.match.id,
    dateTime: m.match.dateTime,
    venue: m.match.venue,
    round: m.match.round,
    status: m.match.status,
    homeTeam: {
      id: m.homeTeam.id,
      name: m.homeTeam.name,
      logo: m.homeTeam.logo,
    },
    awayTeam: {
      id: m.awayTeam.id,
      name: m.awayTeam.name,
      logo: m.awayTeam.logo,
    },
    league: {
      id: m.league.id,
      name: m.league.name,
    },
    syncStatus: syncMap.get(m.match.id) || null,
  }))

  return new Response(JSON.stringify(response), {
    headers: { "Content-Type": "application/json" },
  })
}
```

### POST /api/calendario/sync

Sincronizar partido con calendario.

```typescript
// src/pages/api/calendario/sync.ts
import type { APIRoute } from "astro"
import { syncMatchToCalendar } from "../../../lib/calendar/service"

export const POST: APIRoute = async ({ request, locals }) => {
  const user = locals.user
  if (!user) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 })
  }

  if (user.provider === "apple") {
    return new Response(
      JSON.stringify({ error: "Use /api/calendario/download for Apple" }),
      { status: 400 }
    )
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
    return new Response(
      JSON.stringify({ success: false, error: result.error }),
      { status: 500 }
    )
  }
}
```

### GET /api/calendario/download

Descargar archivo .ics.

```typescript
// src/pages/api/calendario/download.ts
import type { APIRoute } from "astro"
import { generateICS } from "../../../lib/calendar/ics"
import { createDb } from "../../../lib/db"
import { getUpcomingMatches } from "../../../lib/db/queries"

export const GET: APIRoute = async ({ url, locals }) => {
  const user = locals.user
  if (!user) {
    return new Response("Unauthorized", { status: 401 })
  }

  const db = createDb(locals.runtime.env.DB)
  const teamId = url.searchParams.get("teamId")
  const matchId = url.searchParams.get("matchId")

  let matches = await getUpcomingMatches(db, user.id, 100)

  // Filtrar
  if (matchId) {
    matches = matches.filter(m => m.match.id === matchId)
  } else if (teamId) {
    matches = matches.filter(
      m => m.match.homeTeamId === teamId || m.match.awayTeamId === teamId
    )
  }

  const events = matches.map(m => ({
    id: m.match.id,
    homeTeam: m.homeTeam.name,
    awayTeam: m.awayTeam.name,
    dateTime: new Date(m.match.dateTime),
    venue: m.match.venue || undefined,
    league: m.league.name,
    round: m.match.round || undefined,
  }))

  const ics = generateICS(events)

  return new Response(ics, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="fisture-partidos.ics"',
    },
  })
}
```

## Tipos de Ambiente

```typescript
// src/env.d.ts
/// <reference types="astro/client" />

interface Env {
  DB: D1Database
  KV: KVNamespace
  R2: R2Bucket
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  MICROSOFT_CLIENT_ID: string
  MICROSOFT_CLIENT_SECRET: string
  APPLE_CLIENT_ID: string
  APPLE_TEAM_ID: string
  APPLE_KEY_ID: string
  APPLE_PRIVATE_KEY: string
  RAPIDAPI_KEY: string
  ADMIN_SECRET: string
  APP_URL: string
  ENVIRONMENT: string
}

declare namespace App {
  interface Locals {
    runtime: {
      env: Env
    }
    user?: {
      id: string
      email: string
      name?: string
      image?: string
      provider: string
    }
  }
}
```

## Manejo de Errores

```typescript
// src/lib/api-error.ts
export class ApiError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message)
  }
}

export function handleError(error: unknown): Response {
  console.error(error)

  if (error instanceof ApiError) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: error.statusCode }
    )
  }

  return new Response(
    JSON.stringify({ error: "Internal server error" }),
    { status: 500 }
  )
}
```

## Rate Limiting (Opcional)

```typescript
// src/lib/rate-limit.ts
export async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<boolean> {
  const current = await kv.get(`ratelimit:${key}`)
  const count = current ? parseInt(current) : 0

  if (count >= limit) {
    return false
  }

  await kv.put(`ratelimit:${key}`, String(count + 1), {
    expirationTtl: windowSeconds,
  })

  return true
}
```

## Resumen de Endpoints

| Método | Ruta | Descripción | Auth |
|--------|------|-------------|------|
| GET | /api/auth/login/[provider] | Iniciar OAuth | No |
| GET | /api/auth/callback/[provider] | OAuth callback | No |
| POST | /api/auth/logout | Cerrar sesión | Sí |
| GET | /api/equipos/buscar?q= | Buscar equipos | Sí |
| POST | /api/equipos | Agregar equipo | Sí |
| DELETE | /api/equipos/[id] | Eliminar equipo | Sí |
| GET | /api/partidos | Próximos partidos | Sí |
| POST | /api/calendario/sync | Sync a calendario | Sí |
| GET | /api/calendario/download | Descargar .ics | Sí |
| POST | /api/admin/sync | Sync manual | Admin |
