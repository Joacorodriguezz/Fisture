# FISTURE - Fixture Sync

App para sincronizar partidos de fútbol con tu calendario personal.

## Stack

- **Frontend**: Astro (SSR) + React (islands) + Tailwind CSS
- **Backend**: Cloudflare Workers (APIs)
- **Database**: Cloudflare D1 (SQLite) + Drizzle ORM
- **Cache**: Cloudflare KV (sesiones)
- **Auth**: Arctic + Oslo (OAuth)
- **Deploy**: Cloudflare Pages

## Comandos

```bash
npm run dev          # Servidor de desarrollo
npm run build        # Build para producción
npm run db:generate  # Generar migraciones Drizzle
npm run db:migrate:local  # Aplicar migraciones localmente
npm run db:migrate:prod   # Aplicar migraciones en producción
npm run sync:check        # Verificar el sync de competencias (ESPN) contra una D1 efímera
```

## Estructura

```
src/
├── pages/           # Rutas (Astro file-based routing)
│   └── api/         # API endpoints (Workers)
├── components/      # Componentes Astro y React
├── layouts/         # Layouts
└── lib/             # Lógica de negocio
    ├── db/          # Cliente y queries D1
    ├── auth/        # OAuth y sesiones
    ├── football-api/# Cliente API-Football
    └── calendar/    # Integración calendarios

drizzle/
├── schema.ts        # Schema de tablas
├── migrations/      # SQL migrations
└── seed.ts          # Datos iniciales
```

## Convenciones

- Archivos `.astro` para páginas y componentes estáticos (0 JS)
- Archivos `.tsx` en `components/islands/` para interactividad (React)
- APIs en `pages/api/` se despliegan como Workers
- Usar `client:visible` para islands que requieren JS

## Flujo de ramas

```
main         → producción (lo deployado en Cloudflare Pages)
development  → integración / staging (rama por defecto del repo)
feat/* fix/* chore/* docs/* ci/*  → trabajo diario, salen de development
```

- **Nunca** se pushea directo a `main` ni a `development`: ambas están protegidas por rulesets (PR + check `build` obligatorio, sin force-push ni borrado, sin bypass).
- **Features y fixes**: rama desde `development` → PR a `development` → **Squash and merge** (un commit por feature).
- **Release**: PR `development` → `main` con **Create a merge commit** (único método permitido en `main`; evita que ambas ramas diverjan). Al mergear se deploya a producción.
- **Hotfix urgente**: `fix/*` desde `main` → PR a `main`, y después PR de `main` → `development` para no perder el arreglo.
- Preview deployments: cada PR y `development` generan un preview en Cloudflare Pages.
- CI (`.github/workflows/ci.yml`): job `build` (`npm ci` + `npm run build`) en cada PR y push a `main` o `development`. Debe pasar para poder mergear.
- Nombres de rama: `tipo/descripcion-corta` en minúsculas y con guiones. Commits en formato Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`).
- Al crear PRs, apuntar a `development` salvo que sea un release o hotfix.
