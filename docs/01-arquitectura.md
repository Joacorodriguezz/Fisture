# Arquitectura de FISTURE

## Stack Tecnológico

| Componente | Tecnología | Razón |
|------------|------------|-------|
| **Frontend** | Astro | 0 JS por defecto, integración nativa Cloudflare |
| **Runtime** | Cloudflare Workers | <5ms cold start (V8 isolates) |
| **Base de datos** | Cloudflare D1 | 0ms cold start, SQLite en el edge |
| **Cache** | Cloudflare KV | Key-value en el edge |
| **Auth** | Arctic + Oslo | OAuth ligero para Workers |
| **ORM** | Drizzle | Type-safe, soporta D1 |
| **Styling** | Tailwind CSS | Utility-first |
| **Hosting** | Cloudflare Pages | 300+ ubicaciones, gratis |

## Diagrama de Arquitectura General

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLIENTE                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                      │
│  │   Browser   │  │   Mobile    │  │    PWA      │                      │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                      │
└─────────┼────────────────┼────────────────┼─────────────────────────────┘
          │                │                │
          └────────────────┼────────────────┘
                           │ HTTPS
                           ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    CLOUDFLARE EDGE (300+ ciudades)                       │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                      Cloudflare Pages + Workers                    │  │
│  │                                                                    │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                │  │
│  │  │   Astro     │  │   Workers   │  │   Cron      │                │  │
│  │  │  (SSR/SSG)  │  │   (API)     │  │  (Scheduled)│                │  │
│  │  │  <5ms       │  │  <5ms       │  │  1x/día     │                │  │
│  │  └─────────────┘  └─────────────┘  └─────────────┘                │  │
│  │         │                │                │                        │  │
│  │         └────────────────┼────────────────┘                        │  │
│  │                          │                                         │  │
│  │                          ▼                                         │  │
│  │  ┌─────────────────────────────────────────────────────────────┐  │  │
│  │  │                    Cloudflare Bindings                       │  │  │
│  │  │  ┌───────────┐  ┌───────────┐  ┌───────────┐                │  │  │
│  │  │  │    D1     │  │    KV     │  │   R2      │                │  │  │
│  │  │  │ (SQLite)  │  │  (Cache)  │  │ (Storage) │                │  │  │
│  │  │  │  0.5ms    │  │   <1ms    │  │  (logos)  │                │  │  │
│  │  │  └───────────┘  └───────────┘  └───────────┘                │  │  │
│  │  └─────────────────────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    │ 1 request/día
                                    ▼
                         ┌─────────────────────┐
                         │    API-Football     │
                         │     (RapidAPI)      │
                         └─────────────────────┘

                         ┌─────────────────────┐
                         │   Calendar APIs     │
                         │  Google / Outlook   │
                         └─────────────────────┘
```

## Tiempos de Respuesta

| Operación | Tiempo | Razón |
|-----------|--------|-------|
| Cold start Worker | <5ms | V8 isolates (no containers) |
| Query D1 | 0.5ms | SQLite embebido en Worker |
| Lectura KV | <1ms | Edge cache |
| Página completa | <100ms | Todo en el edge |

## Flujo de Datos

### 1. Usuario Abre la App
```
Usuario (Buenos Aires)
       │
       ▼
Cloudflare Edge (Buenos Aires)  ← Server más cercano
       │
       ├─► HTML pre-renderizado (cache)  → 10ms
       │
       └─► Si necesita datos frescos:
              │
              ▼
           D1 Query (0.5ms) → Respuesta total: <50ms
```

### 2. Sincronización Diaria (Cron)
```
Cloudflare Cron (9:00 UTC)
       │
       ▼
Worker scheduled handler
       │
       ├─► API-Football (1 request por liga)
       │         │
       │         ▼
       │   Respuesta: ~50 partidos por liga
       │
       └─► D1: UPSERT partidos
              │
              ▼
        KV: Invalidar cache
```

### 3. Usuario Agrega Equipo
```
POST /api/equipos/favoritos
       │
       ▼
Worker API handler
       │
       ├─► D1: INSERT user_teams
       │
       ├─► D1: SELECT partidos del equipo
       │
       └─► Si autoSync habilitado:
              │
              ▼
        Google Calendar API: Crear eventos
```

## Estructura de Carpetas

```
fisture/
├── src/
│   ├── pages/                    # File-based routing (Astro)
│   │   ├── index.astro           # Landing page
│   │   ├── login.astro           # Login con OAuth
│   │   ├── equipos/
│   │   │   ├── index.astro       # Mis equipos favoritos
│   │   │   ├── buscar.astro      # Buscar equipos
│   │   │   └── [id].astro        # Detalle de equipo
│   │   ├── partidos/
│   │   │   ├── index.astro       # Próximos partidos
│   │   │   └── [id].astro        # Detalle de partido
│   │   ├── calendario.astro      # Gestión de sync
│   │   ├── config.astro          # Configuración
│   │   └── api/                  # API endpoints (Workers)
│   │       ├── auth/
│   │       │   ├── login/[provider].ts
│   │       │   ├── callback/[provider].ts
│   │       │   └── logout.ts
│   │       ├── equipos/
│   │       │   ├── index.ts      # GET buscar, POST agregar
│   │       │   └── [id].ts       # DELETE eliminar
│   │       ├── partidos/
│   │       │   └── index.ts      # GET partidos del usuario
│   │       └── calendario/
│   │           ├── sync.ts       # POST sincronizar
│   │           └── download.ts   # GET descargar .ics
│   │
│   ├── components/
│   │   ├── PartidoCard.astro     # Card de partido (0 JS)
│   │   ├── EquipoCard.astro      # Card de equipo (0 JS)
│   │   ├── SearchInput.astro     # Buscador
│   │   ├── Navbar.astro          # Navegación
│   │   ├── Footer.astro          # Footer
│   │   └── islands/              # Componentes interactivos
│   │       ├── CalendarButton.tsx    # Requiere JS (React)
│   │       └── ThemeToggle.tsx       # Toggle dark mode
│   │
│   ├── layouts/
│   │   ├── Layout.astro          # Layout principal
│   │   └── AuthLayout.astro      # Layout para páginas auth
│   │
│   ├── lib/
│   │   ├── db/
│   │   │   ├── index.ts          # Cliente D1 + Drizzle
│   │   │   ├── queries.ts        # Queries comunes
│   │   │   └── types.ts          # Tipos inferidos
│   │   ├── auth/
│   │   │   ├── providers.ts      # Config OAuth (Arctic)
│   │   │   ├── session.ts        # Manejo de sesión (KV)
│   │   │   └── middleware.ts     # Auth middleware
│   │   ├── football-api/
│   │   │   ├── client.ts         # Cliente API-Football
│   │   │   └── sync.ts           # Lógica de sincronización
│   │   ├── calendar/
│   │   │   ├── google.ts         # Google Calendar
│   │   │   ├── microsoft.ts      # Outlook
│   │   │   └── ics.ts            # Generador .ics
│   │   └── utils.ts              # Utilidades
│   │
│   ├── middleware.ts             # Astro middleware (auth check)
│   │
│   └── env.d.ts                  # Tipos de environment
│
├── drizzle/
│   ├── schema.ts                 # Definición de tablas
│   ├── migrations/               # Migraciones SQL
│   └── seed.ts                   # Datos iniciales (ligas)
│
├── functions/
│   └── scheduled.ts              # Cron handler (sync diario)
│
├── public/
│   ├── favicon.svg
│   └── fonts/
│
├── astro.config.mjs              # Config Astro + Cloudflare
├── wrangler.toml                 # Config Cloudflare (D1, KV, Cron)
├── drizzle.config.ts             # Config Drizzle
├── tailwind.config.mjs           # Config Tailwind
├── tsconfig.json
└── package.json
```

## Configuración de Cloudflare

```toml
# wrangler.toml
name = "fisture"
compatibility_date = "2024-01-01"
pages_build_output_dir = "./dist"

# Base de datos D1
[[d1_databases]]
binding = "DB"
database_name = "fisture-db"
database_id = "xxx"

# Cache KV
[[kv_namespaces]]
binding = "KV"
id = "xxx"

# Storage R2 (opcional, para logos)
[[r2_buckets]]
binding = "R2"
bucket_name = "fisture-assets"

# Cron job diario
[triggers]
crons = ["0 9 * * *"]  # 9:00 UTC = 6:00 Argentina

# Variables de entorno
[vars]
ENVIRONMENT = "production"
```

## Patrones de Diseño

### 1. Islands Architecture (Astro)
Solo los componentes interactivos cargan JavaScript.

```astro
---
// La mayoría del contenido es HTML estático (0 JS)
import PartidoCard from "../components/PartidoCard.astro"
// Solo el botón de calendario necesita interactividad
import CalendarButton from "../components/islands/CalendarButton.tsx"

const partidos = await getPartidos()
---

{partidos.map(p => (
  <PartidoCard partido={p}>
    <!-- Este componente SÍ carga JS (React) -->
    <CalendarButton client:visible matchId={p.id} />
  </PartidoCard>
))}
```

### 2. Edge-First Data Fetching
Todos los datos vienen de D1/KV en el edge.

```typescript
// src/lib/db/queries.ts
export async function getPartidosUsuario(db: D1Database, userId: string) {
  // Ejecuta en el mismo datacenter que el usuario
  // Latencia: ~0.5ms
  return db.prepare(`
    SELECT m.*,
           ht.name as home_team_name, ht.logo as home_team_logo,
           at.name as away_team_name, at.logo as away_team_logo
    FROM matches m
    JOIN teams ht ON m.home_team_id = ht.id
    JOIN teams at ON m.away_team_id = at.id
    JOIN user_teams ut ON (ut.team_id = m.home_team_id OR ut.team_id = m.away_team_id)
    WHERE ut.user_id = ?
      AND m.date_time > datetime('now')
    ORDER BY m.date_time
    LIMIT 20
  `).bind(userId).all()
}
```

### 3. Session en KV (Stateless Workers)
Las sesiones se guardan en KV, no en memoria.

```typescript
// src/lib/auth/session.ts
export async function createSession(kv: KVNamespace, userId: string): Promise<string> {
  const sessionId = crypto.randomUUID()
  await kv.put(`session:${sessionId}`, userId, { expirationTtl: 60 * 60 * 24 * 30 }) // 30 días
  return sessionId
}

export async function getSession(kv: KVNamespace, sessionId: string): Promise<string | null> {
  return kv.get(`session:${sessionId}`)
}
```

## Principios de Arquitectura

1. **Edge-First**: Todo corre lo más cerca posible del usuario
2. **Zero JS by Default**: Solo cargar JS cuando es necesario (islands)
3. **No Cold Starts**: Workers + D1 = siempre caliente
4. **Simple over Complex**: SQLite > PostgreSQL para este caso de uso
5. **Cache Aggressively**: KV para datos que no cambian frecuentemente
6. **Fail Gracefully**: Si falla el sync de calendario, la app sigue funcionando
