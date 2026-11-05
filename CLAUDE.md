# FISTURE - Fixture Sync

App para sincronizar partidos de fútbol con tu calendario personal.

## Stack

- **Frontend**: Astro (SSR) + React (islands) + Tailwind CSS
- **Backend**: Cloudflare Workers (APIs)
- **Database**: Cloudflare D1 (SQLite) + Drizzle ORM
- **Cache**: Cloudflare KV (sesiones)
- **Auth**: Arctic + Oslo (OAuth)
- **Deploy**: Cloudflare Pages, por subida directa desde GitHub Actions (el proyecto no tiene Git conectado)

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
- Todo handler declara su política de límite de tasa (`withApi(handler, { rateLimit: [...] })`, valores en `lib/rate-limit/policies.ts`); una mutación sin política cae en el límite genérico. `withApi` también verifica el origen (`esMismoOrigen`, única implementación en `lib/auth/guards.ts`) y el `Content-Type` JSON de las mutaciones. Los contadores viven en D1 (`rate_limits`), **nunca en KV** (KV solo se lee, para el interruptor). Apagado de emergencia sin deploy: clave KV `ratelimit:modo=off` (`docs/23` §6; los secrets `RATE_LIMIT_*` rigen solo tras un deploy). Diseño: `docs/16`.
- Logs: usar `locals.logger` en handlers y `rootLogger` en servicios (`lib/observability/logger.ts`). Formato JSON; nunca `console.*` directo ni datos personales/credenciales (las claves sensibles se enmascaran).
- Cada sync (cron o `POST /api/admin/sync`) pasa por `runSync` y queda en la tabla `sync_runs`, con chequeos de consistencia. `sync_runs.kind` distingue `leagues` de `calendars` (docs/17).
- En producción (Workers Free, 50 subrequests por invocación) el sync diario va por lotes de 5 competencias: `{"lote": n}` hasta que `siguienteLote` sea `null` (`docs/22`).
- Competencias: solo las destacadas (ligas, Champions, Europa, Conference, Libertadores, Sudamericana) se listan; las copas nacionales y supercopas aparecen en el fixture de cada equipo (`leagues.is_featured`, `docs/22`).
- `GET /api/health` (público): 200 ok/degraded, 503 fail. `GET /api/admin/status` (Bearer `ADMIN_SECRET`): salud, últimos 20 runs, conteo de sesiones vigentes y vencidas, y métricas de producto agregadas sin ids (`lib/observability/metricas.ts`).
- Calendarios en producción: el job `calendarios` de `sync-cron.yml` corre `scripts/sync-calendarios.mjs` después de las ligas. Encadena `POST /api/admin/sync` con `{"calendarios": true, "corte": ms}` hasta que `siguiente` sea `false` (un barrido). Cada lote atiende a unos pocos usuarios (hasta `PARTIDOS_POR_TURNO` = 4 partidos cada uno) dentro de 45 subrequests (D1 y calendario instrumentados, `calendar/presupuesto.ts`); el primer lote (sin `corte`) detecta los eventos desactualizados de todos. Detalle en `docs/17`.
- `/api/health` mide por separado ligas (`checks.sync`) y calendarios (`checks.calendars`: sin runs de calendarios queda en `ok` y como máximo llega a `degraded`, nunca a 503); `/api/admin/status` trae `runs` (ligas), `runsCalendarios` y `metricas.calendariosSinAcceso`.
- Alertas: `sync-cron.yml` (sync de ligas o de calendarios fallido), `monitor.yml` (`/api/health` cada 30 min) y `keepalive.yml` (semanal: reactiva los workflows programados que GitHub desactiva tras 60 días sin actividad y avisa si el sync diario lleva más de 72 h sin terminar bien) abren un issue con la etiqueta `incidente` (GitHub avisa por email) y lo cierran al recuperarse. Pasos a seguir: `docs/23-runbook-de-incidentes.md`.
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

## Autenticación y cuentas

- La identidad de un login es `(provider, provider_id)` (`oauth_identities`), nunca el email (`docs/18-vinculacion-de-cuentas-tdd.md`). Los tokens son por identidad; `users.provider` es el calendario activo y el login no lo cambia.
- Un login nuevo con el email de una cuenta existente da `email_en_uso` (mensaje genérico, sin revelar el proveedor de la otra cuenta) y se vincula a mano desde Configuración (`POST /api/auth/vincular/[provider]`). El auto-vínculo con ambos lados verificados existe pero está apagado (`AUTO_VINCULAR_EMAIL_VERIFICADO`). Microsoft se trata siempre como no verificado.
- Antes de un release con la migración 0010: `npm run db:check-emails` (docs/23 §6).
- `users.access_token`, `refresh_token`, `token_expires_at` y `provider_id` están deprecadas (doble escritura hasta el release N+1). Nunca leer tokens de `users` sin pasar por `getValidAccessToken`.

## Calendario

- Agregar un partido es idempotente (id determinístico en Google, etiqueta `fisture.matchId` en Microsoft, índice único `(user_id, match_id)`). Nunca se crea un evento nuevo ante un error transitorio (5xx, 429, red).
- Estados de `calendar_syncs.status`: `pending`, `synced`, `needs_update`, `failed`, `detached` (el usuario borró el evento: el cron no lo recrea) y `cancelled` (partido cancelado, evento quitado).
- La reconciliación (`reconcileCalendarBatch`, por lotes, ver Observabilidad) corrige los eventos desactualizados de todos los usuarios, tengan o no auto-sync. Se detecta cambio de hora, sede, postergado y cancelado. Rota por `users.calendar_reconciled_at` (el menos atendido primero) y solo atiende a quien tiene trabajo real. Solo un error de token (`invalid_grant`, falta de refresh token o de access token) pasa al usuario a `calendar_auth_status = 'reauth_required'`: sale de la cola hasta que vuelva a iniciar sesión (el callback OAuth lo reactiva).
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
main         → producción (lo despliega .github/workflows/deploy.yml en Cloudflare Pages)
development  → integración / staging en development.fisture.pages.dev (rama por defecto del repo)
feat/* fix/* chore/* docs/* ci/*  → trabajo diario, salen de development
```

- **Nunca** se pushea directo a `main` ni a `development`: ambas están protegidas por rulesets (PR + check `build` obligatorio, sin force-push ni borrado, sin bypass).
- **Features y fixes**: rama desde `development` → PR a `development` → **Squash and merge** (un commit por feature).
- **Release**: PR `development` → `main` con **Create a merge commit** (único método permitido en `main`; evita que ambas ramas diverjan). Al mergear, `deploy.yml` corre la suite completa, aplica las migraciones de D1, despliega el artefacto probado y hace un smoke de solo lectura contra `PUBLIC_APP_URL`.
- **Hotfix urgente**: `fix/*` desde `main` → PR a `main`, y después PR de `main` → `development` para no perder el arreglo.
- Staging: cada push a `development` se despliega con `staging.yml` en https://development.fisture.pages.dev (preview de Pages, D1 `fisture-staging` y KV propios vía `[env.preview]` de `wrangler.toml`, sin indexar). Los PRs no tienen preview. Producción es solo `main`, vía `deploy.yml`. Detalle: `docs/26-staging-tdd.md`.
- CI (`.github/workflows/ci.yml`): llama a la suite reutilizable (`test-suite.yml`: typecheck, cobertura, build y E2E) en cada PR y push a `development`; el job `build` exige su resultado y debe pasar para poder mergear. Detalle en `docs/13-testing-y-release.md`.
- Nombres de rama: `tipo/descripcion-corta` en minúsculas y con guiones. Commits en formato Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`).
- Al crear PRs, apuntar a `development` salvo que sea un release o hotfix.
