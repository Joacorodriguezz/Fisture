# APIs Externas - FISTURE

## API Principal: API-Football (RapidAPI)

### Información General
- **URL Base**: `https://api-football-v1.p.rapidapi.com/v3`
- **Documentación**: https://www.api-football.com/documentation-v3
- **Free Tier**: 100 requests/día
- **Rate Limit**: 10 requests/minuto

### Estrategia: 1 Request Diario por Liga

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      ESTRATEGIA DE SINCRONIZACIÓN                        │
└─────────────────────────────────────────────────────────────────────────┘

                    Cloudflare Cron (9:00 UTC)
                              │
                              ▼
                    ┌─────────────────┐
                    │  Worker Cron    │
                    │  Handler        │
                    └────────┬────────┘
                             │
           ┌─────────────────┼─────────────────┐
           │                 │                 │
           ▼                 ▼                 ▼
    Liga Argentina    Premier League    La Liga ...
    (1 request)       (1 request)       (1 request)
           │                 │                 │
           └─────────────────┼─────────────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │  ~50 partidos   │
                    │  por liga       │
                    └────────┬────────┘
                             │
                             ▼
                    ┌─────────────────┐
                    │   D1: UPSERT    │
                    │   partidos      │
                    └─────────────────┘

    Total: 6 requests/día = 180/mes << 3000/mes límite
```

### Cliente de API-Football

```typescript
// src/lib/football-api/client.ts

const API_HOST = "api-football-v1.p.rapidapi.com"

interface ApiFootballConfig {
  apiKey: string
}

export function createFootballApiClient(config: ApiFootballConfig) {
  async function request<T>(endpoint: string, params: Record<string, string | number> = {}): Promise<T> {
    const url = new URL(`https://${API_HOST}/v3${endpoint}`)

    Object.entries(params).forEach(([key, value]) => {
      url.searchParams.append(key, String(value))
    })

    const response = await fetch(url.toString(), {
      headers: {
        "X-RapidAPI-Key": config.apiKey,
        "X-RapidAPI-Host": API_HOST,
      },
    })

    if (!response.ok) {
      throw new Error(`API-Football error: ${response.status} ${response.statusText}`)
    }

    const data = await response.json()

    if (data.errors && Object.keys(data.errors).length > 0) {
      throw new Error(`API-Football errors: ${JSON.stringify(data.errors)}`)
    }

    return data.response as T
  }

  return {
    // Obtener partidos de una liga
    async getFixtures(leagueId: number, season: number, options?: { from?: string; to?: string; next?: number }) {
      return request<Fixture[]>("/fixtures", {
        league: leagueId,
        season,
        ...(options?.from && { from: options.from }),
        ...(options?.to && { to: options.to }),
        ...(options?.next && { next: options.next }),
        timezone: "America/Argentina/Buenos_Aires",
      })
    },

    // Obtener equipos de una liga
    async getTeams(leagueId: number, season: number) {
      return request<Team[]>("/teams", {
        league: leagueId,
        season,
      })
    },

    // Obtener ligas activas
    async getLeagues(country?: string) {
      return request<League[]>("/leagues", {
        current: "true",
        ...(country && { country }),
      })
    },
  }
}

// Tipos de respuesta
export interface Fixture {
  fixture: {
    id: number
    referee: string | null
    timezone: string
    date: string
    timestamp: number
    venue: {
      id: number | null
      name: string | null
      city: string | null
    }
    status: {
      long: string
      short: string // NS, 1H, HT, 2H, FT, PST, CANC
      elapsed: number | null
    }
  }
  league: {
    id: number
    name: string
    country: string
    logo: string
    round: string
  }
  teams: {
    home: { id: number; name: string; logo: string; winner: boolean | null }
    away: { id: number; name: string; logo: string; winner: boolean | null }
  }
  goals: {
    home: number | null
    away: number | null
  }
}

export interface Team {
  team: {
    id: number
    name: string
    code: string | null
    country: string
    founded: number | null
    national: boolean
    logo: string
  }
  venue: {
    id: number | null
    name: string | null
    address: string | null
    city: string | null
    capacity: number | null
  }
}

export interface League {
  league: {
    id: number
    name: string
    type: string
    logo: string
  }
  country: {
    name: string
    code: string | null
    flag: string | null
  }
  seasons: Array<{
    year: number
    start: string
    end: string
    current: boolean
  }>
}
```

### Ligas Soportadas

```typescript
// src/lib/football-api/leagues.ts

export const SUPPORTED_LEAGUES = [
  { apiId: 128, name: "Liga Profesional Argentina", country: "Argentina" },
  { apiId: 39, name: "Premier League", country: "England" },
  { apiId: 140, name: "La Liga", country: "Spain" },
  { apiId: 135, name: "Serie A", country: "Italy" },
  { apiId: 78, name: "Bundesliga", country: "Germany" },
  { apiId: 61, name: "Ligue 1", country: "France" },
] as const

export function getCurrentSeason(): number {
  const now = new Date()
  const month = now.getMonth() + 1
  const year = now.getFullYear()

  // La temporada empieza en agosto
  return month >= 8 ? year : year - 1
}
```

### Servicio de Sincronización

```typescript
// src/lib/football-api/sync.ts
import { createFootballApiClient, type Fixture } from "./client"
import { SUPPORTED_LEAGUES, getCurrentSeason } from "./leagues"
import { createDb } from "../db"
import { teams, matches, leagues } from "../../../drizzle/schema"
import { eq } from "drizzle-orm"

interface SyncResult {
  league: string
  teamsCreated: number
  teamsUpdated: number
  matchesCreated: number
  matchesUpdated: number
  errors: string[]
}

export async function syncAllLeagues(env: Env): Promise<SyncResult[]> {
  const api = createFootballApiClient({ apiKey: env.RAPIDAPI_KEY })
  const db = createDb(env.DB)
  const season = getCurrentSeason()
  const results: SyncResult[] = []

  for (const league of SUPPORTED_LEAGUES) {
    const result: SyncResult = {
      league: league.name,
      teamsCreated: 0,
      teamsUpdated: 0,
      matchesCreated: 0,
      matchesUpdated: 0,
      errors: [],
    }

    try {
      // 1. Asegurar que la liga existe en DB
      await db
        .insert(leagues)
        .values({
          apiId: league.apiId,
          name: league.name,
          country: league.country,
          season,
          isActive: true,
        })
        .onConflictDoUpdate({
          target: leagues.apiId,
          set: { season, isActive: true },
        })

      const dbLeague = await db.query.leagues.findFirst({
        where: eq(leagues.apiId, league.apiId),
      })

      if (!dbLeague) continue

      // 2. Sincronizar equipos (solo si no existen)
      const existingTeams = await db.query.teams.findMany({
        where: eq(teams.leagueId, dbLeague.id),
      })

      if (existingTeams.length === 0) {
        const apiTeams = await api.getTeams(league.apiId, season)

        for (const t of apiTeams) {
          await db.insert(teams).values({
            apiId: t.team.id,
            name: t.team.name,
            shortName: t.team.code,
            logo: t.team.logo,
            leagueId: dbLeague.id,
            country: t.team.country,
          }).onConflictDoNothing()

          result.teamsCreated++
        }
      }

      // 3. Sincronizar partidos (próximos 30 días)
      const today = new Date()
      const thirtyDaysLater = new Date(today)
      thirtyDaysLater.setDate(thirtyDaysLater.getDate() + 30)

      const fixtures = await api.getFixtures(league.apiId, season, {
        from: formatDate(today),
        to: formatDate(thirtyDaysLater),
      })

      for (const fixture of fixtures) {
        const homeTeam = await db.query.teams.findFirst({
          where: eq(teams.apiId, fixture.teams.home.id),
        })
        const awayTeam = await db.query.teams.findFirst({
          where: eq(teams.apiId, fixture.teams.away.id),
        })

        if (!homeTeam || !awayTeam) {
          result.errors.push(`Teams not found for fixture ${fixture.fixture.id}`)
          continue
        }

        const existingMatch = await db.query.matches.findFirst({
          where: eq(matches.apiId, fixture.fixture.id),
        })

        const matchData = {
          apiId: fixture.fixture.id,
          homeTeamId: homeTeam.id,
          awayTeamId: awayTeam.id,
          leagueId: dbLeague.id,
          dateTime: new Date(fixture.fixture.date),
          venue: fixture.fixture.venue.name,
          status: mapStatus(fixture.fixture.status.short),
          homeScore: fixture.goals.home,
          awayScore: fixture.goals.away,
          round: fixture.league.round,
        }

        if (existingMatch) {
          await db
            .update(matches)
            .set({ ...matchData, updatedAt: new Date() })
            .where(eq(matches.id, existingMatch.id))
          result.matchesUpdated++
        } else {
          await db.insert(matches).values(matchData)
          result.matchesCreated++
        }
      }
    } catch (error) {
      result.errors.push(error instanceof Error ? error.message : "Unknown error")
    }

    results.push(result)
  }

  return results
}

function mapStatus(apiStatus: string): string {
  const statusMap: Record<string, string> = {
    NS: "scheduled",
    "1H": "live",
    HT: "live",
    "2H": "live",
    FT: "finished",
    AET: "finished",
    PEN: "finished",
    PST: "postponed",
    CANC: "cancelled",
    ABD: "cancelled",
    AWD: "finished",
    WO: "finished",
  }
  return statusMap[apiStatus] || "scheduled"
}

function formatDate(date: Date): string {
  return date.toISOString().split("T")[0]
}
```

### Worker Cron Handler

```typescript
// functions/scheduled.ts

export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    console.log(`[CRON] Starting sync at ${new Date().toISOString()}`)

    try {
      const { syncAllLeagues } = await import("../src/lib/football-api/sync")
      const results = await syncAllLeagues(env)

      // Log resultados
      for (const result of results) {
        console.log(`[CRON] ${result.league}:`, {
          teams: `${result.teamsCreated} created`,
          matches: `${result.matchesCreated} created, ${result.matchesUpdated} updated`,
          errors: result.errors.length,
        })
      }

      // Invalidar cache de partidos en KV
      await env.KV.delete("cache:matches:all")

      console.log(`[CRON] Sync completed at ${new Date().toISOString()}`)
    } catch (error) {
      console.error(`[CRON] Sync failed:`, error)
    }
  },
}
```

### Endpoint Manual de Sync (para testing)

```typescript
// src/pages/api/admin/sync.ts
import type { APIRoute } from "astro"
import { syncAllLeagues } from "../../../lib/football-api/sync"

export const POST: APIRoute = async ({ locals, request }) => {
  const env = locals.runtime.env

  // Verificar admin secret
  const authHeader = request.headers.get("Authorization")
  if (authHeader !== `Bearer ${env.ADMIN_SECRET}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  try {
    const results = await syncAllLeagues(env)

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { "Content-Type": "application/json" },
    })
  } catch (error) {
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    )
  }
}
```

## Uso de API Estimado

| Operación | Requests/día | Requests/mes |
|-----------|--------------|--------------|
| Sync 6 ligas | 6 | 180 |
| Equipos (una vez) | 6 | 6 |
| Buffer errores | 4 | 120 |
| **Total** | **~10** | **~300** |

**Límite free tier**: 100/día = 3000/mes
**Uso real**: ~10% del límite

## Variables de Entorno

```toml
# wrangler.toml
[triggers]
crons = ["0 9 * * *"]  # 9:00 UTC = 6:00 Argentina
```

```bash
# Secrets
wrangler secret put RAPIDAPI_KEY
wrangler secret put ADMIN_SECRET
```

## Manejo de Errores y Retry

```typescript
// src/lib/football-api/client.ts (adicional)

async function requestWithRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delay = 1000
): Promise<T> {
  let lastError: Error | undefined

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      // Si es rate limit, esperar más
      if (lastError.message.includes("429")) {
        await sleep(delay * (i + 1) * 2)
      } else {
        await sleep(delay * (i + 1))
      }
    }
  }

  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
```
