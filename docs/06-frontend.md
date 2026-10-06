# Frontend - FISTURE

## Stack de Frontend

| Tecnología | Uso |
|------------|-----|
| **Astro** | Framework (SSR + Islands) |
| **Tailwind CSS** | Styling |
| **React** | Componentes interactivos (islands) |
| **TypeScript** | Type safety |

## Principio: Islands Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         PÁGINA TÍPICA                                    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Navbar.astro                                    (0 JS)          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  PartidoCard.astro                               (0 JS)          │    │
│  │  ┌─────────────────────────────────────────────────────────┐    │    │
│  │  │  CalendarButton.tsx                    (React, ~2KB JS)  │    │    │
│  │  └─────────────────────────────────────────────────────────┘    │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  Footer.astro                                    (0 JS)          │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  Total JS enviado: ~2KB (solo el botón interactivo)                     │
└─────────────────────────────────────────────────────────────────────────┘
```

## Páginas

### Landing Page

```astro
---
// src/pages/index.astro
import Layout from "../layouts/Layout.astro"
---

<Layout title="FISTURE - Tus partidos en tu calendario">
  <main class="min-h-screen">
    <!-- Hero -->
    <section class="py-20 px-4 text-center bg-gradient-to-b from-blue-600 to-blue-800 text-white">
      <h1 class="text-5xl font-bold mb-4">FISTURE</h1>
      <p class="text-xl mb-8 opacity-90">
        Sincroniza los partidos de tus equipos favoritos con tu calendario
      </p>
      <a href="/login" class="btn btn-white btn-lg">
        Comenzar gratis
      </a>
    </section>

    <!-- Features -->
    <section class="py-16 px-4 max-w-6xl mx-auto">
      <div class="grid md:grid-cols-3 gap-8">
        <div class="text-center">
          <div class="text-4xl mb-4">📅</div>
          <h3 class="font-bold mb-2">Sync automático</h3>
          <p class="text-gray-600">Los partidos aparecen en tu Google Calendar o Outlook</p>
        </div>
        <div class="text-center">
          <div class="text-4xl mb-4">⚽</div>
          <h3 class="font-bold mb-2">Múltiples ligas</h3>
          <p class="text-gray-600">Argentina, Premier League, La Liga y más</p>
        </div>
        <div class="text-center">
          <div class="text-4xl mb-4">🔔</div>
          <h3 class="font-bold mb-2">Recordatorios</h3>
          <p class="text-gray-600">Notificaciones 1 hora y 15 minutos antes</p>
        </div>
      </div>
    </section>
  </main>
</Layout>
```

### Mis Equipos

```astro
---
// src/pages/equipos/index.astro
import Layout from "../../layouts/Layout.astro"
import EquipoCard from "../../components/EquipoCard.astro"
import { createDb } from "../../lib/db"
import { getUserTeamsWithNextMatch } from "../../lib/db/queries"

const user = Astro.locals.user
const db = createDb(Astro.locals.runtime.env.DB)
const userTeams = await getUserTeamsWithNextMatch(db, user.id)
---

<Layout title="Mis Equipos">
  <div class="max-w-4xl mx-auto px-4 py-8">
    <div class="flex justify-between items-center mb-8">
      <h1 class="text-3xl font-bold">Mis Equipos</h1>
      <a href="/equipos/buscar" class="btn btn-primary">
        + Agregar equipo
      </a>
    </div>

    {userTeams.length === 0 ? (
      <div class="text-center py-12 bg-gray-50 rounded-lg">
        <p class="text-gray-600 mb-4">No seguís ningún equipo todavía</p>
        <a href="/equipos/buscar" class="btn btn-primary">
          Buscar equipos
        </a>
      </div>
    ) : (
      <div class="grid gap-4 md:grid-cols-2">
        {userTeams.map(ut => (
          <EquipoCard
            team={ut.team}
            league={ut.team.league}
            autoSync={ut.autoSync}
          />
        ))}
      </div>
    )}
  </div>
</Layout>
```

### Buscar Equipos

```astro
---
// src/pages/equipos/buscar.astro
import Layout from "../../layouts/Layout.astro"
import SearchTeams from "../../components/islands/SearchTeams.tsx"
---

<Layout title="Buscar Equipos">
  <div class="max-w-2xl mx-auto px-4 py-8">
    <h1 class="text-3xl font-bold mb-8">Buscar Equipos</h1>

    <!-- Componente React para búsqueda interactiva -->
    <SearchTeams client:load />
  </div>
</Layout>
```

### Próximos Partidos

```astro
---
// src/pages/partidos/index.astro
import Layout from "../../layouts/Layout.astro"
import PartidoCard from "../../components/PartidoCard.astro"
import { createDb } from "../../lib/db"
import { getUpcomingMatches } from "../../lib/db/queries"

const user = Astro.locals.user
const db = createDb(Astro.locals.runtime.env.DB)
const matches = await getUpcomingMatches(db, user.id, 20)
---

<Layout title="Próximos Partidos">
  <div class="max-w-4xl mx-auto px-4 py-8">
    <h1 class="text-3xl font-bold mb-8">Próximos Partidos</h1>

    {matches.length === 0 ? (
      <div class="text-center py-12 bg-gray-50 rounded-lg">
        <p class="text-gray-600">No hay partidos próximos</p>
      </div>
    ) : (
      <div class="space-y-4">
        {matches.map(m => (
          <PartidoCard
            match={m.match}
            homeTeam={m.homeTeam}
            awayTeam={m.awayTeam}
            league={m.league}
            userId={user.id}
            provider={user.provider}
          />
        ))}
      </div>
    )}
  </div>
</Layout>
```

## Componentes

### Layout Principal

```astro
---
// src/layouts/Layout.astro
import Navbar from "../components/Navbar.astro"
import "../styles/global.css"

interface Props {
  title: string
}

const { title } = Astro.props
const user = Astro.locals.user
---

<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>{title}</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
  </head>
  <body class="min-h-screen bg-gray-50">
    {user && <Navbar user={user} />}
    <slot />
  </body>
</html>
```

### Navbar

```astro
---
// src/components/Navbar.astro
interface Props {
  user: {
    name: string
    email: string
    image?: string
  }
}

const { user } = Astro.props
const currentPath = Astro.url.pathname
---

<nav class="bg-white border-b sticky top-0 z-50">
  <div class="max-w-6xl mx-auto px-4">
    <div class="flex justify-between items-center h-16">
      <a href="/equipos" class="font-bold text-xl">FISTURE</a>

      <div class="flex items-center gap-6">
        <a
          href="/equipos"
          class={`hover:text-blue-600 ${currentPath.startsWith('/equipos') ? 'text-blue-600 font-medium' : ''}`}
        >
          Equipos
        </a>
        <a
          href="/partidos"
          class={`hover:text-blue-600 ${currentPath.startsWith('/partidos') ? 'text-blue-600 font-medium' : ''}`}
        >
          Partidos
        </a>

        <div class="relative group">
          <button class="flex items-center gap-2">
            {user.image ? (
              <img src={user.image} alt="" class="w-8 h-8 rounded-full" />
            ) : (
              <div class="w-8 h-8 rounded-full bg-blue-600 text-white flex items-center justify-center">
                {user.name?.charAt(0).toUpperCase()}
              </div>
            )}
          </button>

          <div class="absolute right-0 mt-2 w-48 bg-white rounded-lg shadow-lg border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all">
            <div class="px-4 py-2 border-b">
              <p class="font-medium truncate">{user.name}</p>
              <p class="text-sm text-gray-500 truncate">{user.email}</p>
            </div>
            <form action="/api/auth/logout" method="POST">
              <button type="submit" class="w-full text-left px-4 py-2 hover:bg-gray-50">
                Cerrar sesión
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  </div>
</nav>
```

### Card de Equipo

```astro
---
// src/components/EquipoCard.astro
interface Props {
  team: {
    id: string
    name: string
    logo?: string
  }
  league: {
    name: string
  }
  autoSync: boolean
}

const { team, league, autoSync } = Astro.props
---

<div class="bg-white rounded-lg shadow p-4 flex items-center gap-4">
  <img
    src={team.logo || "/placeholder-team.svg"}
    alt={team.name}
    class="w-16 h-16 object-contain"
  />

  <div class="flex-1">
    <a href={`/equipos/${team.id}`} class="font-bold hover:text-blue-600">
      {team.name}
    </a>
    <p class="text-sm text-gray-500">{league.name}</p>
  </div>

  <div class="flex items-center gap-2">
    {autoSync && (
      <span class="text-xs bg-green-100 text-green-700 px-2 py-1 rounded">
        Auto-sync
      </span>
    )}
  </div>
</div>
```

### Card de Partido

```astro
---
// src/components/PartidoCard.astro
import CalendarButton from "./islands/CalendarButton.tsx"

interface Props {
  match: {
    id: string
    dateTime: Date
    venue?: string
    round?: string
  }
  homeTeam: { name: string; logo?: string }
  awayTeam: { name: string; logo?: string }
  league: { name: string }
  userId: string
  provider: string
}

const { match, homeTeam, awayTeam, league, userId, provider } = Astro.props

const date = new Date(match.dateTime)
const formattedDate = date.toLocaleDateString("es-AR", {
  weekday: "long",
  day: "numeric",
  month: "long",
})
const formattedTime = date.toLocaleTimeString("es-AR", {
  hour: "2-digit",
  minute: "2-digit",
})
---

<div class="bg-white rounded-lg shadow p-4">
  <div class="flex items-center justify-between mb-4">
    <span class="text-xs bg-gray-100 px-2 py-1 rounded">{league.name}</span>
    {match.round && <span class="text-xs text-gray-500">{match.round}</span>}
  </div>

  <div class="flex items-center justify-between mb-4">
    <div class="flex items-center gap-3 flex-1">
      <img
        src={homeTeam.logo || "/placeholder-team.svg"}
        alt={homeTeam.name}
        class="w-12 h-12 object-contain"
      />
      <span class="font-medium">{homeTeam.name}</span>
    </div>

    <span class="text-2xl font-bold text-gray-300 px-4">vs</span>

    <div class="flex items-center gap-3 flex-1 justify-end">
      <span class="font-medium">{awayTeam.name}</span>
      <img
        src={awayTeam.logo || "/placeholder-team.svg"}
        alt={awayTeam.name}
        class="w-12 h-12 object-contain"
      />
    </div>
  </div>

  <div class="flex items-center justify-between text-sm text-gray-600 border-t pt-4">
    <div>
      <p class="capitalize">{formattedDate}</p>
      <p class="font-medium">{formattedTime}</p>
      {match.venue && <p class="text-xs">{match.venue}</p>}
    </div>

    <CalendarButton
      client:visible
      matchId={match.id}
      provider={provider}
    />
  </div>
</div>
```

## Islands (Componentes Interactivos)

### Buscador de Equipos

```tsx
// src/components/islands/SearchTeams.tsx
import { useState, useEffect } from "react"

interface Team {
  id: string
  name: string
  logo?: string
  league: { name: string }
  isFollowing: boolean
}

export default function SearchTeams() {
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<Team[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (query.length < 2) {
      setResults([])
      return
    }

    const timeout = setTimeout(async () => {
      setLoading(true)
      try {
        const res = await fetch(`/api/equipos/buscar?q=${encodeURIComponent(query)}`)
        const data = await res.json()
        setResults(data)
      } catch (e) {
        console.error(e)
      } finally {
        setLoading(false)
      }
    }, 300)

    return () => clearTimeout(timeout)
  }, [query])

  const addTeam = async (teamId: string) => {
    try {
      await fetch("/api/equipos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      })

      setResults(results.map(t =>
        t.id === teamId ? { ...t, isFollowing: true } : t
      ))
    } catch (e) {
      console.error(e)
    }
  }

  return (
    <div>
      <input
        type="text"
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder="Buscar equipo..."
        className="w-full px-4 py-3 border rounded-lg focus:ring-2 focus:ring-blue-500 outline-none"
      />

      {loading && <p className="mt-4 text-gray-500">Buscando...</p>}

      {results.length > 0 && (
        <div className="mt-4 space-y-2">
          {results.map(team => (
            <div
              key={team.id}
              className="flex items-center gap-4 p-3 bg-white rounded-lg border"
            >
              <img
                src={team.logo || "/placeholder-team.svg"}
                alt={team.name}
                className="w-10 h-10 object-contain"
              />
              <div className="flex-1">
                <p className="font-medium">{team.name}</p>
                <p className="text-sm text-gray-500">{team.league.name}</p>
              </div>
              {team.isFollowing ? (
                <span className="text-green-600 text-sm">Siguiendo</span>
              ) : (
                <button
                  onClick={() => addTeam(team.id)}
                  className="btn btn-primary btn-sm"
                >
                  Agregar
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

## Estilos Globales

```css
/* src/styles/global.css */
@tailwind base;
@tailwind components;
@tailwind utilities;

@layer components {
  .btn {
    @apply inline-flex items-center justify-center px-4 py-2 rounded-lg font-medium transition;
  }

  .btn-primary {
    @apply bg-blue-600 text-white hover:bg-blue-700;
  }

  .btn-white {
    @apply bg-white text-blue-600 hover:bg-gray-100;
  }

  .btn-success {
    @apply bg-green-600 text-white;
  }

  .btn-sm {
    @apply px-3 py-1.5 text-sm;
  }

  .btn-lg {
    @apply px-6 py-3 text-lg;
  }
}
```

## Configuración de Astro

```javascript
// astro.config.mjs
import { defineConfig } from "astro/config"
import cloudflare from "@astrojs/cloudflare"
import tailwind from "@astrojs/tailwind"
import react from "@astrojs/react"

export default defineConfig({
  output: "server",
  adapter: cloudflare({
    platformProxy: {
      enabled: true,
    },
  }),
  integrations: [
    tailwind(),
    react(),
  ],
})
```

## Dependencias

```bash
npm create astro@latest
npx astro add cloudflare tailwind react
```
