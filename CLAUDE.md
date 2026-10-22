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
npm test                  # Tests (guard de descubrimiento + Vitest, D1 efímera con Miniflare)
npm run typecheck         # astro check
npm run test:coverage     # Vitest con umbrales de cobertura
npm run test:e2e          # Playwright (escritorio y móvil); requiere npm run build
npm run check             # Lo que corre el CI: typecheck, discovery, cobertura, build y E2E
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

## Observabilidad

- Todo handler de `pages/api/**` se exporta envuelto con `withApi(...)` (`lib/observability/with-api.ts`): requestId (header `x-request-id`), log de request y captura de excepciones (500 uniforme).
- Logs: usar `locals.logger` en handlers y `rootLogger` en servicios (`lib/observability/logger.ts`). Formato JSON; nunca `console.*` directo ni datos personales/credenciales (las claves sensibles se enmascaran).
- Cada sync (cron o `POST /api/admin/sync`) pasa por `runSync` y queda en la tabla `sync_runs`, con chequeos de consistencia.
- `GET /api/health` (público): 200 ok/degraded, 503 fail. `GET /api/admin/status` (Bearer `ADMIN_SECRET`): salud + últimos 20 runs.
- Ver logs en vivo: `npx wrangler pages deployment tail`. Diseño completo: `docs/10-observabilidad-tdd.md`.

## Commits y Pull Requests

Guía basada en https://midu.dev/buenas-practicas-escribir-commits-git/. **Claude debe seguirla en cada commit y PR.**

### Commits

Formato: `tipo(scope): título` + línea en blanco + cuerpo opcional + footer opcional.

- **Tipos**: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `style`, `build`, `ci`, `chore`, `revert` (`release` solo en PRs `development` → `main`).
- **Scope** opcional, en minúsculas: área afectada (`api`, `sync`, `auth`, `calendar`, `ui`, `db`).
- **Título**: imperativo ("agrega", "corrige", "elimina"), máx. **50 caracteres**, sin punto final ni puntos suspensivos. Test: "Si aplico este commit, entonces este commit… <título>".
- Si el título no entra en 50 caracteres, el commit probablemente hace demasiado: **dividirlo** (un commit = un cambio lógico, atómico).
- **Cuerpo** (cuando el porqué no es obvio): líneas de máx. 72 caracteres, explica *qué* y *por qué*, no *cómo*.
- **Footer**: `Closes #123` / `Fixes #123` cierran el issue al llegar a la rama por defecto; `Refs #123` solo referencia. No cerrar issues a mano.
- Terminar con la línea `Co-Authored-By` indicada por el entorno.
- Evitar: pasado ("agregado", "Fixed"), mezclar cambios no relacionados, mensajes vagos (`fix`, `wip`, `cambios`).

Hook `commit-msg` (`.githooks/`) valida tipo, longitud, puntuación y línea en blanco. Instalación una vez por clon: `npm run hooks:install` (también activa la plantilla `.gitmessage`).

### Pull Requests

- **Título**: mismo formato que un commit (`tipo(scope): título`, ≤ 50 caracteres, imperativo). Con *Squash and merge* pasa a ser el commit en `development`.
- **Descripción**: usar `.github/pull_request_template.md` (Resumen, Cambios, Tipo, Cómo probarlo, Checklist, Despliegue y riesgos, Issues). No dejar secciones vacías: escribir "n/a" o "Ninguno".
- Para releases usar `.github/PULL_REQUEST_TEMPLATE/release.md` (título `release: <resumen>`, merge commit).
- Un PR = un propósito. Explicar el *porqué* en el Resumen; el diff ya muestra el *qué*.
- Migraciones D1, variables de entorno nuevas y breaking changes se declaran siempre en "Despliegue y riesgos".
- Con `gh pr create`, pasar el cuerpo siguiendo la plantilla (`--body-file`) y terminar con la línea de atribución del entorno.

## Calendario

- Agregar un partido es idempotente (id determinístico en Google, etiqueta `fisture.matchId` en Microsoft, índice único `(user_id, match_id)`). Nunca se crea un evento nuevo ante un error transitorio (5xx, 429, red).
- Estados de `calendar_syncs.status`: `pending`, `synced`, `needs_update`, `failed`, `detached` (el usuario borró el evento: el cron no lo recrea) y `cancelled` (partido cancelado, evento quitado).
- El cron (`reconcileCalendars`) corrige los eventos desactualizados de todos los usuarios, tengan o no auto-sync. Se detecta cambio de hora, sede, postergado y cancelado.
- Los títulos de eventos ajenos (aviso de solapamiento) no se loguean ni se guardan. Diseño completo: `docs/11-calendario-casos-borde-tdd.md`.

## Cambios grandes: TDD primero

- Cada vez que el usuario pida un cambio grande (feature nueva, rediseño, refactor amplio, cambios de datos o de integraciones), lo primero que se entrega es un **TDD (Technical Design Document)**, no código.
- El TDD se guarda en `docs/` con numeración correlativa (`docs/NN-tema-tdd.md`), siguiendo como modelo `docs/10-observabilidad-tdd.md` y `docs/11-calendario-casos-borde-tdd.md`.
- El TDD registra: contexto/problema; objetivos y no objetivos; decisiones con su porqué y alternativas descartadas; estrategia de tests (test primero: rojo, verde, refactor); plan de implementación por pasos; despliegue/rollback; riesgos; y una sección de **notas de implementación** vacía al inicio.
- La implementación empieza solo después de que el usuario revise y apruebe el TDD. Al terminar, se completa la sección de notas de implementación con los desvíos respecto del diseño.

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
- CI (`.github/workflows/ci.yml`): llama a la suite reutilizable (`test-suite.yml`: typecheck, cobertura, build y E2E) en cada PR y push a `development`; el job `build` exige su resultado y debe pasar para poder mergear. Detalle en `docs/13-testing-y-release.md`.
- Nombres de rama: `tipo/descripcion-corta` en minúsculas y con guiones. Commits en formato Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`).
- Al crear PRs, apuntar a `development` salvo que sea un release o hotfix.
