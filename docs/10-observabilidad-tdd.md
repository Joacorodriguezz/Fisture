# TDD: Observabilidad de la API

> Technical Design Document. Estado: **propuesto** (pendiente de aprobación). Rama de implementación: `feat/observabilidad`, desde `development`.

## 1. Contexto y problema

Hoy la observabilidad se reduce a unos pocos `console.log` sueltos:

| Archivo | Logs |
| --- | --- |
| `src/lib/calendar/sync-service.ts` | 3 |
| `src/pages/api/admin/sync.ts` | 5 |
| `functions/scheduled.ts` | 6 |
| `src/pages/api/auth/callback/[provider].ts` | 1 |
| `src/lib/data-providers/promiedos.ts` | 1 |

Los endpoints `partidos`, `equipos`, `calendario` y `preferencias` no registran nada. No hay formato común, ni correlación entre logs de una misma request, ni captura uniforme de errores, ni historial de sincronizaciones, ni endpoint de salud.

**Riesgo principal:** el sync depende de ESPN (y otros proveedores). Si falla o cambia el formato, los partidos quedan desactualizados y nadie se entera. Además, el `catch` de `functions/scheduled.ts` solo hace `console.error`, así que un fallo del cron es silencioso.

## 2. Objetivos y no objetivos

**Objetivos**

1. Todo request a `/api/*` deja un log estructurado (JSON) con `requestId`, ruta, status y duración.
2. Toda excepción no controlada se captura, se loguea con contexto y devuelve una respuesta de error uniforme.
3. Cada ejecución de sync (cron o manual) queda registrada en la base, con resultado por competencia.
4. Un endpoint `/api/health` permite saber si el sistema está sano y, en particular, si el sync está al día.
5. Chequeos de consistencia de datos después de cada sync, con sus hallazgos registrados.
6. Todo lo anterior cubierto por tests automáticos y sin agregar dependencias de runtime.

**No objetivos (fuera de esta iteración)**

- Sentry, Logpush, Analytics Engine y métricas de negocio (ver §11).
- Resolver que el cron no corre en Cloudflare Pages. Es un trabajo aparte, pero este diseño lo deja detectable (ver §7.3).
- Dashboards propios.

## 3. Diseño general

```
Request ──► middleware (requestId, cronómetro, log de request)
              │
              ├─► handler envuelto con withApi() ──► lógica ──► Response
              │        └─ excepción ► logger.error + respuesta uniforme
              │
Cron / POST /api/admin/sync ──► runSync() ──► tabla sync_runs (+ logs)
                                     └─► checkConsistency() ──► sync_runs.issues

GET /api/health ──► lee sync_runs + ping a D1 y KV ──► 200 | 503
```

Piezas nuevas (todas bajo `src/lib/observability/`):

| Módulo | Responsabilidad |
| --- | --- |
| `logger.ts` | Logger JSON con niveles y contexto |
| `with-api.ts` | Wrapper de handlers: requestId, tiempo, captura de errores |
| `sync-runs.ts` | Registrar inicio, fin y resultado de cada sync |
| `consistency.ts` | Consultas de chequeo de integridad |
| `health.ts` | Cálculo del estado de salud (función pura, testeable) |

## 4. Logger estructurado (`logger.ts`)

- Emite una línea JSON por evento con `console.log` / `console.warn` / `console.error` según el nivel. Cloudflare indexa esos campos para búsqueda.
- Campos fijos: `ts` (ISO), `level` (`debug|info|warn|error`), `msg`, `env` (`ENVIRONMENT`) y el contexto del logger.
- `logger.child({ requestId, route })` devuelve un logger que hereda el contexto.
- Nivel mínimo configurable: `info` en producción, `debug` fuera de ella.
- Los `Error` se serializan como `{ name, message, stack }`.
- **Redacción de datos sensibles:** se enmascaran claves como `authorization`, `cookie`, `token`, `secret`, `password`, `access_token`, `refresh_token`. Se loguea `userId`, nunca el email ni tokens OAuth.

Ejemplo de salida:

```json
{"ts":"2026-10-16T12:00:00.000Z","level":"info","msg":"request","requestId":"b1c2…","method":"GET","route":"/api/partidos","status":200,"durationMs":42,"userId":"u_123"}
```

## 5. Wrapper de handlers (`with-api.ts`)

```ts
export const GET: APIRoute = withApi(async (ctx) => { … });
```

Responsabilidades:

1. Generar `requestId` (`crypto.randomUUID()`), o reutilizar `cf-ray` si viene en el header.
2. Medir la duración.
3. Capturar excepciones. Se loguean con `logger.error` (con stack, ruta, `userId`) y se responde `500 { error: "Internal error", requestId }` con `Content-Type: application/json`. El mensaje interno **no** se expone al cliente.
4. Loguear al final un evento `request` con método, ruta, status y duración. Los status 5xx se loguean como `error`, los 4xx como `warn`, el resto como `info`.
5. Devolver el header `x-request-id` en la respuesta, para poder cruzar el reporte de un usuario con los logs.

Alcance: se aplica a todos los handlers de `src/pages/api/**`. Los `Response` que ya devuelve cada handler no cambian (misma forma de cuerpo y mismos status), salvo el 500 inesperado. Hoy los handlers que no tienen `try/catch` devuelven una página de error de Astro.

El middleware (`src/middleware.ts`) solo se toca para dejar `requestId` en `locals`. La medición y el log viven en `withApi` para no mezclar páginas con API.

## 6. Registro de sincronizaciones

### 6.1 Esquema (migración `0004_sync_runs.sql`)

```sql
CREATE TABLE sync_runs (
  id            TEXT PRIMARY KEY,
  trigger       TEXT NOT NULL,           -- 'cron' | 'admin'
  started_at    INTEGER NOT NULL,        -- epoch ms
  finished_at   INTEGER,                 -- NULL mientras corre o si murió
  status        TEXT NOT NULL,           -- 'running' | 'success' | 'partial' | 'failed'
  duration_ms   INTEGER,
  results       TEXT NOT NULL DEFAULT '[]',  -- JSON: SyncResult[] por competencia
  issues        TEXT NOT NULL DEFAULT '[]',  -- JSON: hallazgos de consistencia
  error         TEXT                     -- mensaje si falló todo el run
);
CREATE INDEX idx_sync_runs_started ON sync_runs(started_at DESC);
```

Se agrega la tabla correspondiente a `drizzle/schema.ts` y el SQL a `drizzle/migrations/`. Convención del repo: SQL escrito a mano, numerado, con cabecera `-- Migration:`. También se agrega `0004_sync_runs.sql` a `MIGRACIONES` en `scripts/sync-check.mjs`.

### 6.2 Flujo (`sync-runs.ts`)

- `startSyncRun(db, trigger)` inserta la fila con `status = 'running'`.
- `finishSyncRun(db, id, results, issues)` calcula el estado: `success` si ninguna competencia reportó errores, `partial` si algunas sí y otras no, `failed` si todas fallaron. Guarda duración y resultados.
- `failSyncRun(db, id, error)` cubre excepciones fuera del bucle de competencias.
- Una fila `running` con más de 10 minutos se considera **colgada** (el Worker murió) y `/api/health` la reporta.
- Retención: al insertar un run nuevo se borran los de más de 30 días. No hace falta un job aparte.

### 6.3 Dónde se engancha

`functions/scheduled.ts` y `src/pages/api/admin/sync.ts` hoy duplican la lógica (sync, log, invalidación de KV). Se extrae a `runSync(env, trigger)` y ambos lo llaman. Los `console.*` de ese código pasan a `logger`. El `catch` del cron deja de ser silencioso: registra `failSyncRun` y `logger.error`.

## 7. Endpoint de salud

### 7.1 `GET /api/health` (público, sin datos sensibles)

```json
{ "status": "ok", "checks": { "db": "ok", "kv": "ok", "sync": "ok" }, "lastSyncAt": "2026-10-16T09:00:12.000Z" }
```

- `200` si todo está `ok` o solo hay `degraded`. `503` si algún check está en `fail`.
- Agregar `/api/health` a `PUBLIC_PATHS` del middleware.
- Checks:
  - **db:** `SELECT 1` contra D1.
  - **kv:** lectura de una clave trivial.
  - **sync:** según el último run.

### 7.2 Reglas del check de sync (función pura en `health.ts`)

| Condición | Estado |
| --- | --- |
| Último run `success` hace menos de 26 h | `ok` |
| Último run `partial`, o el último `success` tiene entre 26 h y 50 h | `degraded` |
| Último run `failed`, sin runs, último `success` de más de 50 h, o run `running` colgado | `fail` |

26 h = intervalo diario (24 h) más margen. Los umbrales son constantes exportadas.

### 7.3 Detección de cron muerto

Como el cron podría no estar corriendo en Pages, "sin runs recientes" es `fail` y no `ok`. Es deliberado: el primer valor que da este diseño es avisar de eso.

### 7.4 Detalle para admin

`GET /api/admin/status` (con `Authorization: Bearer ADMIN_SECRET`, igual que `/api/admin/sync`): últimos 20 runs con resultados por competencia e `issues`. `/api/health` público no expone eso.

## 8. Chequeos de consistencia (`consistency.ts`)

Se ejecutan al final de cada sync, y sus hallazgos se guardan en `sync_runs.issues`. No bloquean el sync.

| Código | Consulta | Severidad |
| --- | --- | --- |
| `match_missing_team` | partidos cuyo `home_team_id` o `away_team_id` no existe en `teams` | error |
| `match_same_team` | partidos con local = visitante | error |
| `stale_scheduled` | `status = 'scheduled'` con `date_time` de más de 3 h en el pasado | warn |
| `duplicate_match` | misma liga, mismos equipos y misma fecha repetidos | error |
| `empty_league` | competencia activa sin partidos futuros ni de la temporada | warn |
| `finished_without_score` | `finished` con marcador nulo | warn |

Cada hallazgo: `{ code, severity, count, sample: [ids, máx. 5] }`. Si hay alguno con severidad `error`, el run queda al menos `partial` y se loguea `logger.error`.

Los nombres exactos de columnas se confirman contra `drizzle/schema.ts` al implementar.

## 9. Estrategia de pruebas (TDD)

El repo hoy **no tiene framework de tests**. Se agrega **Vitest** como devDependency (consistente con Vite, que ya usa Astro). Los tests con D1 usan Miniflare, que `scripts/sync-check.mjs` ya emplea.

Orden de trabajo: **primero el test (rojo), después la implementación (verde), después el refactor.** Cada módulo se desarrolla así.

| Módulo | Tests clave |
| --- | --- |
| `logger` | emite JSON válido; respeta nivel mínimo; `child` hereda contexto; serializa `Error`; redacta `token`/`authorization`/`cookie` también en objetos anidados |
| `withApi` | devuelve la respuesta del handler sin alterarla; agrega `x-request-id`; excepción → 500 JSON sin filtrar el mensaje interno; loguea el nivel según status (5xx error, 4xx warn); reutiliza `cf-ray` |
| `health` (puro) | tabla del §7.2 completa, con fechas inyectadas; cubre sin runs y run colgado |
| `sync-runs` (D1/Miniflare) | `start` → `finish` calcula `success`/`partial`/`failed`; `fail` guarda el error; runs de más de 30 días se purgan; un `running` viejo se detecta como colgado |
| `consistency` (D1/Miniflare) | cada código detecta su caso sembrado; una base sana devuelve lista vacía; el `sample` se limita a 5 |
| `/api/health` | 200 con base sana; 503 si el sync está en `fail`; no expone detalles internos |
| `/api/admin/status` | 401 sin token; 200 con token y devuelve los runs |
| `runSync` | un proveedor que falla produce un run `partial` y el cron no se interrumpe; el error queda en `sync_runs` y en el log |

Scripts nuevos en `package.json`: `test` (`vitest run`) y `test:watch`. Se agrega `npm test` al job `build` de `.github/workflows/ci.yml` (el check requerido se sigue llamando `build`, para no tocar los rulesets).

Verificación manual al final: `npm run sync:check` y `curl` a `/api/health` en `wrangler pages dev`.

## 10. Plan de implementación

Cada paso es un commit (Conventional Commits) dentro de la rama `feat/observabilidad`; el PR a `development` se mergea con squash.

| # | Paso | Entregable |
| --- | --- | --- |
| 0 | Infra de tests | Vitest + Miniflare configurados, `npm test` en CI, un test de humo |
| 1 | Logger | tests + `logger.ts` |
| 2 | `withApi` | tests + `with-api.ts`; aplicado a todos los handlers de `src/pages/api/**` |
| 3 | `sync_runs` | migración `0004`, schema Drizzle, tests + `sync-runs.ts` |
| 4 | `runSync` | extraer lógica común de cron y admin; reemplazar `console.*`; el cron deja de fallar en silencio |
| 5 | Consistencia | tests + `consistency.ts`, integrado en `runSync` |
| 6 | Health | tests + `health.ts`, `/api/health`, `/api/admin/status`, ruta pública en middleware |
| 7 | Cierre | `[observability] enabled = true` en `wrangler.toml`; actualizar `CLAUDE.md` y `docs/08` con cómo mirar logs y salud; ejecutar `sync:check` |

### Despliegue y rollback

1. Aplicar `0004_sync_runs.sql` en producción **antes** del deploy (`npm run db:migrate:prod`). La migración es solo aditiva (tabla nueva), así que el código viejo sigue funcionando con ella.
2. Deploy normal por PR `development` → `main`.
3. Rollback: revertir el merge. La tabla `sync_runs` puede quedar sin uso, no hace daño.

## 11. Después de esta iteración

- Alertas: uptime check externo (UptimeRobot, Better Stack o Cloudflare Health Checks) sobre `/api/health`, con aviso por mail o Telegram.
- Sentry (`@sentry/cloudflare`) para agrupar errores con stack trace.
- Resolver el cron en Pages (Worker separado o GitHub Action programado que llame a `/api/admin/sync`). Con este diseño, `/api/health` pasa a `fail` hasta que se arregle.
- Logpush o Analytics Engine si hace falta retención larga o métricas.

## 12. Riesgos y decisiones abiertas

| Tema | Decisión / riesgo |
| --- | --- |
| Costo en D1 | Un insert y un update por sync diario más una consulta por health check: despreciable. El health check no debe consultarse con una frecuencia menor a 1 min |
| `/api/health` público | Solo devuelve estados y la fecha del último sync, sin errores ni nombres internos |
| Límite de D1 (100 parámetros por consulta) | Las consultas de consistencia no reciben listas de IDs, así que no aplica; si alguna lo necesitara, reutilizar el patrón de lotes de `getSyncStates` |
| Tamaño de `results`/`issues` | JSON acotado: máx. 5 IDs de muestra por hallazgo y errores truncados a 500 caracteres |
| Umbrales de salud (26 h / 50 h) | Provisionales; ajustar si el cron cambia de frecuencia |
| Nivel de log en producción | `info` por defecto. Volumen estimado bajo; revisar si se acerca al límite de logs de Cloudflare |
