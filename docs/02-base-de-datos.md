# Base de Datos - FISTURE

## Proveedor: Cloudflare D1 (SQLite en el Edge)

### Por qué D1

| Característica | D1 | Neon (PostgreSQL) |
|----------------|-----|-------------------|
| Cold start | **0ms** | 300-800ms |
| Latencia lectura | **0.5ms** | 3-10ms |
| Storage gratis | **5GB** | 0.5GB |
| Se duerme? | **No** | Sí (5 min) |
| Complejidad | Baja | Media |

### Cómo funciona

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         Cloudflare Worker                                │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  Tu código                                                         │  │
│  │                                                                    │  │
│  │  const result = await env.DB.prepare("SELECT * FROM matches")     │  │
│  │                              │                                     │  │
│  │                              ▼                                     │  │
│  │                    ┌─────────────────┐                            │  │
│  │                    │       D1        │  ← SQLite embebido         │  │
│  │                    │   (mismo V8)    │  ← Sin network hop         │  │
│  │                    │                 │  ← 0ms cold start          │  │
│  │                    └─────────────────┘                            │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

D1 corre **dentro** del Worker, no hay conexión de red. Por eso es tan rápido.

## ORM: Drizzle

Drizzle es type-safe, ligero y tiene soporte nativo para D1.

```bash
npm install drizzle-orm
npm install -D drizzle-kit
```

## Diagrama Entidad-Relación

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│      users      │       │   user_teams    │       │      teams      │
├─────────────────┤       ├─────────────────┤       ├─────────────────┤
│ id (PK)         │──────<│ user_id (FK)    │>──────│ id (PK)         │
│ email           │       │ team_id (FK)    │       │ api_id          │
│ name            │       │ auto_sync       │       │ name            │
│ image           │       │ created_at      │       │ short_name      │
│ provider        │       └─────────────────┘       │ logo            │
│ provider_id     │                                 │ league_id (FK)  │
│ created_at      │                                 │ country         │
└─────────────────┘                                 └────────┬────────┘
                                                             │
                                                             │
┌─────────────────┐       ┌─────────────────┐       ┌────────┴────────┐
│ calendar_syncs  │       │     matches     │       │     leagues     │
├─────────────────┤       ├─────────────────┤       ├─────────────────┤
│ id (PK)         │       │ id (PK)         │       │ id (PK)         │
│ user_id (FK)    │       │ api_id          │       │ api_id          │
│ match_id (FK)   │──────<│ home_team_id(FK)│       │ name            │
│ provider        │       │ away_team_id(FK)│       │ country         │
│ external_id     │       │ league_id (FK)  │───────│ logo            │
│ status          │       │ date_time       │       │ season          │
│ synced_at       │       │ venue           │       │ is_active       │
└─────────────────┘       │ status          │       └─────────────────┘
                          │ home_score      │
                          │ away_score      │
                          │ round           │
                          └─────────────────┘
```

## Schema con Drizzle

```typescript
// drizzle/schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core"
import { sql } from "drizzle-orm"

// ============================================
// USUARIOS Y AUTH
// ============================================

export const users = sqliteTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  name: text("name"),
  image: text("image"),
  provider: text("provider").notNull(), // 'google' | 'microsoft' | 'apple'
  providerId: text("provider_id").notNull(),
  // Tokens OAuth para Calendar APIs
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  tokenExpiresAt: integer("token_expires_at"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .default(sql`(strftime('%s', 'now'))`),
})

// ============================================
// LIGAS Y EQUIPOS
// ============================================

export const leagues = sqliteTable("leagues", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  apiId: integer("api_id").notNull().unique(),
  name: text("name").notNull(),
  country: text("country").notNull(),
  logo: text("logo"),
  season: integer("season").notNull(),
  isActive: integer("is_active", { mode: "boolean" }).default(true),
})

export const teams = sqliteTable("teams", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  apiId: integer("api_id").notNull().unique(),
  name: text("name").notNull(),
  shortName: text("short_name"),
  logo: text("logo"),
  leagueId: text("league_id").notNull().references(() => leagues.id),
  country: text("country"),
})

// ============================================
// RELACIÓN USUARIO - EQUIPO
// ============================================

export const userTeams = sqliteTable("user_teams", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  autoSync: integer("auto_sync", { mode: "boolean" }).default(true),
  createdAt: integer("created_at", { mode: "timestamp" })
    .default(sql`(strftime('%s', 'now'))`),
})

// ============================================
// PARTIDOS
// ============================================

export const matches = sqliteTable("matches", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  apiId: integer("api_id").notNull().unique(),
  homeTeamId: text("home_team_id").notNull().references(() => teams.id),
  awayTeamId: text("away_team_id").notNull().references(() => teams.id),
  leagueId: text("league_id").notNull().references(() => leagues.id),
  dateTime: integer("date_time", { mode: "timestamp" }).notNull(),
  venue: text("venue"),
  status: text("status").default("scheduled"), // scheduled, live, finished, postponed, cancelled
  homeScore: integer("home_score"),
  awayScore: integer("away_score"),
  round: text("round"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .default(sql`(strftime('%s', 'now'))`),
})

// ============================================
// SINCRONIZACIÓN DE CALENDARIO
// ============================================

export const calendarSyncs = sqliteTable("calendar_syncs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  matchId: text("match_id").notNull().references(() => matches.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(), // 'google' | 'microsoft' | 'apple'
  externalEventId: text("external_event_id"),
  status: text("status").default("pending"), // pending, synced, needs_update, failed, detached, cancelled
  lastSyncedAt: integer("last_synced_at", { mode: "timestamp" }),
  // Con qué fecha, estado ('scheduled' | 'postponed' | 'cancelled') y sede se creó el evento: si el partido
  // cambia respecto de esto, el evento queda needs_update
  syncedDateTime: integer("synced_date_time", { mode: "timestamp" }),
  syncedState: text("synced_state"),
  syncedVenue: text("synced_venue"),
  errorMessage: text("error_message"),
}, (t) => [uniqueIndex("uq_calendar_syncs_user_match").on(t.userId, t.matchId)])
// Estados y casos borde: docs/11-calendario-casos-borde-tdd.md

// ============================================
// TIPOS INFERIDOS
// ============================================

export type User = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

export type Team = typeof teams.$inferSelect
export type League = typeof leagues.$inferSelect
export type Match = typeof matches.$inferSelect
export type UserTeam = typeof userTeams.$inferSelect
export type CalendarSync = typeof calendarSyncs.$inferSelect
```

### Sesiones

Tabla `sessions` (migración `0008_sessions.sql`, `docs/21-sesiones-en-d1-tdd.md`):

| Columna | Tipo | Nota |
| --- | --- | --- |
| `id` | TEXT PK | SHA-256 hexadecimal del token de la cookie (el token no se guarda) |
| `user_id` | TEXT NOT NULL | FK a `users(id)` con `ON DELETE CASCADE` |
| `created_at` | INTEGER NOT NULL | segundos Unix |
| `expires_at` | INTEGER NOT NULL | segundos Unix; fijo a 30 días |

Índices: `sessions_user_id_idx` y `sessions_expires_at_idx`. Las vencidas se purgan dentro de `runSync`.

## Configuración de Drizzle

```typescript
// drizzle.config.ts
import type { Config } from "drizzle-kit"

export default {
  schema: "./drizzle/schema.ts",
  out: "./drizzle/migrations",
  dialect: "sqlite",
  driver: "d1-http",
  dbCredentials: {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    databaseId: process.env.D1_DATABASE_ID!,
    token: process.env.CLOUDFLARE_API_TOKEN!,
  },
} satisfies Config
```

## Cliente de Base de Datos

```typescript
// src/lib/db/index.ts
import { drizzle } from "drizzle-orm/d1"
import * as schema from "../../drizzle/schema"

export function createDb(d1: D1Database) {
  return drizzle(d1, { schema })
}

export type Database = ReturnType<typeof createDb>
```

## Queries Comunes

```typescript
// src/lib/db/queries.ts
import { eq, and, gte, or, desc, inArray } from "drizzle-orm"
import { matches, teams, userTeams, leagues, calendarSyncs } from "../../drizzle/schema"
import type { Database } from "./index"

// Obtener partidos próximos del usuario
export async function getUpcomingMatches(db: Database, userId: string, limit = 20) {
  const now = new Date()

  // Primero obtener los equipos del usuario
  const userTeamIds = await db
    .select({ teamId: userTeams.teamId })
    .from(userTeams)
    .where(eq(userTeams.userId, userId))

  const teamIds = userTeamIds.map(ut => ut.teamId)
  if (teamIds.length === 0) return []

  // Luego obtener los partidos
  return db
    .select({
      match: matches,
      homeTeam: teams,
      awayTeam: teams,
      league: leagues,
    })
    .from(matches)
    .innerJoin(teams, eq(matches.homeTeamId, teams.id))
    .innerJoin(leagues, eq(matches.leagueId, leagues.id))
    .where(
      and(
        gte(matches.dateTime, now),
        or(
          inArray(matches.homeTeamId, teamIds),
          inArray(matches.awayTeamId, teamIds)
        )
      )
    )
    .orderBy(matches.dateTime)
    .limit(limit)
}

// Obtener equipos del usuario con próximo partido
export async function getUserTeamsWithNextMatch(db: Database, userId: string) {
  return db.query.userTeams.findMany({
    where: eq(userTeams.userId, userId),
    with: {
      team: {
        with: {
          league: true,
        },
      },
    },
    orderBy: desc(userTeams.createdAt),
  })
}

// Buscar equipos por nombre
export async function searchTeams(db: Database, query: string, limit = 20) {
  return db
    .select({
      team: teams,
      league: leagues,
    })
    .from(teams)
    .innerJoin(leagues, eq(teams.leagueId, leagues.id))
    .where(
      or(
        like(teams.name, `%${query}%`),
        like(teams.shortName, `%${query}%`)
      )
    )
    .limit(limit)
}

// Agregar equipo a favoritos
export async function addUserTeam(db: Database, userId: string, teamId: string) {
  return db.insert(userTeams).values({
    userId,
    teamId,
    autoSync: true,
  }).returning()
}

// Eliminar equipo de favoritos
export async function removeUserTeam(db: Database, userId: string, teamId: string) {
  return db
    .delete(userTeams)
    .where(
      and(
        eq(userTeams.userId, userId),
        eq(userTeams.teamId, teamId)
      )
    )
}

// Upsert de partidos (para sync diario)
export async function upsertMatch(db: Database, matchData: NewMatch) {
  return db
    .insert(matches)
    .values(matchData)
    .onConflictDoUpdate({
      target: matches.apiId,
      set: {
        dateTime: matchData.dateTime,
        venue: matchData.venue,
        status: matchData.status,
        homeScore: matchData.homeScore,
        awayScore: matchData.awayScore,
        round: matchData.round,
        updatedAt: new Date(),
      },
    })
}

// Obtener syncs pendientes
export async function getPendingSyncs(db: Database) {
  return db
    .select({
      sync: calendarSyncs,
      match: matches,
      user: users,
    })
    .from(calendarSyncs)
    .innerJoin(matches, eq(calendarSyncs.matchId, matches.id))
    .innerJoin(users, eq(calendarSyncs.userId, users.id))
    .where(
      and(
        inArray(calendarSyncs.status, ["pending", "needs_update"]),
        gte(matches.dateTime, new Date())
      )
    )
}
```

## Migraciones

```bash
# Generar migración
npx drizzle-kit generate

# Aplicar migración local
npx wrangler d1 execute fisture-db --local --file=./drizzle/migrations/0001_init.sql

# Aplicar migración en producción
npx wrangler d1 execute fisture-db --file=./drizzle/migrations/0001_init.sql
```

## Seed de Datos Iniciales

```typescript
// drizzle/seed.ts
import { leagues } from "./schema"

export const initialLeagues = [
  { apiId: 128, name: "Liga Profesional Argentina", country: "Argentina", season: 2024 },
  { apiId: 39, name: "Premier League", country: "England", season: 2024 },
  { apiId: 140, name: "La Liga", country: "Spain", season: 2024 },
  { apiId: 135, name: "Serie A", country: "Italy", season: 2024 },
  { apiId: 78, name: "Bundesliga", country: "Germany", season: 2024 },
  { apiId: 61, name: "Ligue 1", country: "France", season: 2024 },
]

export async function seed(db: Database) {
  await db.insert(leagues).values(initialLeagues).onConflictDoNothing()
}
```

## Índices para Performance

```sql
-- migrations/0002_indexes.sql
CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date_time);
CREATE INDEX IF NOT EXISTS idx_matches_home_team ON matches(home_team_id);
CREATE INDEX IF NOT EXISTS idx_matches_away_team ON matches(away_team_id);
CREATE INDEX IF NOT EXISTS idx_user_teams_user ON user_teams(user_id);
CREATE INDEX IF NOT EXISTS idx_user_teams_team ON user_teams(team_id);
CREATE INDEX IF NOT EXISTS idx_calendar_syncs_status ON calendar_syncs(status);
CREATE INDEX IF NOT EXISTS idx_teams_name ON teams(name);
```

## Límites de D1 Free Tier

| Límite | Valor |
|--------|-------|
| Storage | 5 GB |
| Lecturas/día | 5 millones |
| Escrituras/día | 100,000 |
| Filas por query | 10,000 |

Para FISTURE, estos límites son más que suficientes:
- ~5000 partidos × ~1KB = ~5MB
- ~1000 usuarios × ~100 queries/día = 100,000 lecturas
