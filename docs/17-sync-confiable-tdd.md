# TDD: Sync diario confiable (disparo, cobertura de usuarios y alertas)

> Technical Design Document. Estado: **implementado (2026-11-03), con el alcance y los desvíos del §12**. Fecha: 2026-10-22. Rama del documento: `docs/tdd-sync-confiable`, desde `development`. El dueño aprobó el TDD.
>
> Este documento registra **qué problemas hay hoy, qué decidimos y por qué**. El código y los tests se escriben después, siguiendo el orden del §9. Todo lo que no pudimos confirmar está marcado como **a verificar** y tiene un spike en el §9 (paso 0).
>
> **Nota 2026-11-03.** Parte de este TDD quedó cubierta por otros cambios: el sync diario por lotes para entrar en las 50 subrequests de Workers Free (`docs/22` D4) y los avisos por issue cuando falla el sync o `/api/health` (`sync-cron.yml`, `monitor.yml`). Sigue pendiente lo demás: disparo autorreparable, la reconciliación de calendarios (hoy no corre en producción, `docs/22` D7) y la columna `kind` en `sync_runs`.
>
> **Nota 2026-11-03 (implementación).** Lo pendiente se implementó dentro de Workers Free, sin el Worker `fisture-cron` de D1 ni Workers Paid: la reconciliación de calendarios por lotes y presupuesto de subrequests desde `sync-cron.yml`, `sync_runs.kind` con la salud separada, un keepalive para el disparo y el borrado de `functions/scheduled.ts`. Los desvíos y lo que queda fuera están en el §12.

## 1. Contexto y problema

Antes de abrir la app a todo el público, el sync diario tiene que cumplir tres cosas: que **corra** todos los días, que **alcance a todos los usuarios** con el tiempo y que, si falla, **alguien se entere**. Hoy ninguna está garantizada.

Cómo funciona hoy:

- Cloudflare Pages no ejecuta Cron Triggers (`wrangler.toml:22-23` lo deja dicho). El disparo es `.github/workflows/sync-cron.yml`: un `schedule` (`0 9 * * *`) que hace `curl -X POST /api/admin/sync` con `ADMIN_SECRET`. Ese endpoint llama a `runSync(env, "admin", ...)` (`src/pages/api/admin/sync.ts:15`).
- `runSync` (`src/lib/observability/run-sync.ts:41-121`) sincroniza las ligas, deja registro en `sync_runs` y corre los chequeos de consistencia. **Pero el endpoint admin no pasa `calendarAutoSync: true`** (solo el `scheduled.ts` lo hacía), así que hoy el cron real de GitHub **no corrige ningún calendario**.
- `functions/scheduled.ts` define un `scheduled()` que Pages no usa. Es código muerto; además, en Pages todo archivo bajo `functions/` es una ruta (`/scheduled`), por lo que su presencia es confusa (a verificar si el build de Pages lo ignora o lo expone; ver spike S6).
- `reconcileCalendars` (`src/lib/calendar/sync-service.ts:389-417`) procesa como máximo `CRON_MAX_USERS = 20` usuarios y `CRON_MATCHES_PER_USER = 10` partidos por usuario (`:48-50`).
- `/api/health` (público) y `/api/admin/status` (Bearer) exponen el estado del último run (`src/lib/observability/health.ts`), pero **solo si alguien los mira**.

### 1.1 Brechas detectadas en el código actual

| # | Brecha | Dónde | Consecuencia |
| --- | --- | --- | --- |
| B1 | El disparo depende de `schedule` de GitHub Actions. GitHub puede retrasar o saltear runs programados y **desactiva los workflows programados tras 60 días sin actividad en el repo** | `.github/workflows/sync-cron.yml:5-8` | El sync deja de correr sin ningún aviso. Con una app estable (pocos commits) el riesgo es real |
| B2 | El workflow del cron llama a `/api/admin/sync` sin `calendarAutoSync`; solo `functions/scheduled.ts` lo pasa, y Pages no lo ejecuta | `src/pages/api/admin/sync.ts:15`, `functions/scheduled.ts:29` | Los eventos desactualizados y las altas con auto-sync **nunca se procesan en producción** (confirmado leyendo el código; a verificar contra los logs de producción, spike S7) |
| B3 | `reconcileCandidates` ordena por cantidad de pendientes descendente y luego por `userId`, y corta en 20. No hay rotación ni cursor | `sync-service.ts:364-386` | Con más de 20 usuarios con trabajo, los de siempre ocupan los 20 lugares (un usuario con eventos `failed` que se reintentan cada día queda siempre arriba) y los demás **no se procesan nunca**. Los de auto-sync con 0 pendientes quedan siempre al final |
| B4 | Un usuario con el token revocado queda con filas `needs_update`/`failed` y vuelve a ser candidato todos los días, sin marca de "auth caída" | `sync-service.ts:182-189`, `:364-386` | Gasta un lugar del lote y llamadas a diario; nadie sabe cuántos usuarios están sin acceso |
| B5 | El tope es por **usuarios** y partidos, no por **subrequests**. En Workers, cada `fetch` y cada consulta a D1 cuentan como subrequest | `sync-service.ts:48-50` | Con el costo real por partido (varias consultas D1 + 1 llamada al calendario, ver §4.1), 20 usuarios x 10 partidos puede superar el límite de la invocación según el plan (50 en Free, 1.000 consultas D1 en Paid) |
| B6 | `evaluateSyncHealth` mide frescura solo del run de ligas; no mide **cobertura de calendarios** ni usuarios sin auth. Todos los runs comparten la tabla y el "último run" | `health.ts:19-37`, `sync-runs.ts:36-99` | Un run de ligas "success" tapa que los calendarios llevan días sin procesarse |
| B7 | No hay alertas. El smoke del deploy lee `/api/health` solo al mergear a `main` | `scripts/production-smoke.mjs:15-22`, `deploy.yml:77-80` | Un sync caído se descubre cuando un usuario se queja |
| B8 | El `curl` del workflow espera la respuesta con `--max-time 120`; si el sync tarda más, el workflow falla aunque el trabajo siga corriendo en Cloudflare (y al revés, un sync lento no deja registro claro) | `sync-cron.yml:22-24` | Falsos fallos y reintentos (`--retry 2`) que lanzan syncs superpuestos |
| B9 | El smoke post-deploy exige `checks.sync` en `ok` o `degraded`; si el sync lleva más de 50 h caído, **bloquea cualquier deploy**, incluido el que lo arregla | `production-smoke.mjs:21` | Acoplamiento entre salud del sync y capacidad de desplegar el arreglo |

> Verificar en el paso 0 (sin cambiar código): B2 y B3 se confirman leyendo el código, pero conviene mirar `GET /api/admin/status` y los logs de producción para ver qué corrió realmente.

## 2. Objetivos y no objetivos

**Objetivos**

1. El sync corre todos los días **sin depender de GitHub Actions** y se recupera solo de un tick perdido.
2. **Todo** usuario con trabajo pendiente se procesa en un plazo acotado y conocido (objetivo: 24 h hasta 1.000 usuarios, con la ruta de escalado documentada para 10.000), sin que nadie quede relegado por orden.
3. Ninguna invocación supera los límites de Workers: el lote se mide por **presupuesto de subrequests**, no por cantidad de usuarios.
4. Un fallo, un run parcial, un sync viejo o usuarios sin auth **generan un aviso** en un canal que el dueño ya mira, y cada alerta tiene un test.
5. Cada caso del §5 tiene al menos un test escrito **antes** de la implementación.

**No objetivos**

- Cambiar de proveedor de datos (ESPN) ni de plataforma (seguimos en Cloudflare Pages + D1 + KV).
- Notificar al **usuario final** que su calendario perdió acceso (se registra el estado; el aviso al usuario queda para una fase siguiente, §11).
- Colas (Queues) o Durable Objects en esta fase. Se documenta cuándo harían falta (D5, 10.000 usuarios).
- Migrar a Workers con assets (reemplazo de Pages). Es una alternativa descartada (D1).
- Dashboard de métricas.

## 3. Hechos verificados y pendientes

Fuentes: documentación vigente de Cloudflare consultada el 2026-10-22.

| Hecho | Estado | Fuente |
| --- | --- | --- |
| Subrequests por invocación: **50 en Free, 10.000 en Paid** (hasta 10 M configurable). Cuentan `fetch` y llamadas a KV, R2 y D1 | Confirmado | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Consultas D1 por invocación: **50 en Free, 1.000 en Paid**, y cuentan contra el límite de subrequests | Confirmado | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| CPU por Cron Trigger: 10 ms en Free; en Paid, 30 s si el intervalo es menor a 1 h y **15 min** si es de 1 h o más. Duración de pared de un cron: 15 min | Confirmado | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Triggers cron por cuenta: 5 en Free, 250 en Paid | Confirmado (la página lo lista por cuenta) | [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) |
| Máximo de parámetros enlazados por consulta D1: 100 (ya contemplado en `D1_CHUNK = 80`) | Confirmado | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Las Pages Functions se facturan como requests de Workers | Confirmado | [Pages pricing](https://developers.cloudflare.com/pages/functions/pricing/) |
| Un Worker con `scheduled()` + Cron Trigger es el mecanismo de cron; la documentación de bindings de Pages **no menciona** Cron Triggers | Confirmado por ausencia, no hay texto que diga "no soportado". El repo ya lo asume (`wrangler.toml:22`) | [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/) |
| Un Worker separado puede declarar bindings a **la misma** D1 y el mismo KV por `database_id` e `id` | **A verificar** (S1): es el patrón habitual, pero la doc de bindings de Pages no lo afirma textualmente |
| Plan de la cuenta (Free o Paid) | **A verificar** (S1). Define el presupuesto del §4.1: con Free (50 subrequests) el sync actual de ligas ya sería inviable en una sola invocación, lo que sugiere que la cuenta es Paid o que algo falla en silencio |
| Qué hace el build de Pages con `functions/scheduled.ts` | **A verificar** (S6) |
| Cloudflare Email Service para enviar alertas: disponibilidad, costo y requisitos de dominio | **A verificar** (S5). No se confía en ella para el camino principal |

## 4. Decisiones

### D1. Quién dispara: un Worker independiente con Cron Trigger (`fisture-cron`)

Un Worker aparte, en `workers/cron/` con su propio `wrangler.toml`, con `[triggers] crons = ["*/15 * * * *"]`, que declara los **mismos** bindings `DB` (`database_id` `a2c8ced1-...`) y `KV` (`id` `8a9fc92e...`) que el proyecto Pages y se despliega con `wrangler deploy` desde `deploy.yml`. Importa por ruta relativa el código de `src/lib/**` (`runSync`, `reconcileCalendars`); Wrangler empaqueta con esbuild, así que no hay duplicación ni paquete compartido.

Por qué:
- Es el único mecanismo soportado de cron en Cloudflare; corre en la infraestructura de Cloudflare, no depende de la actividad del repo ni de la cola de GitHub.
- Reutiliza el código y los tests existentes (`runSync` ya es inyectable).
- El límite de CPU de un cron en Paid es de 15 min con intervalo >= 1 h (30 s para menos de 1 h; ver D4 y el spike S2 sobre cuál aplica a una cadencia de 15 min), y 15 min de pared: sobra para un lote acotado.
- Habilita un **tick frecuente** (D3) que da reintentos naturales: un tick perdido se compensa en el siguiente.

Requiere: variables y secretos propios del Worker (`GOOGLE_CLIENT_ID/SECRET`, `MICROSOFT_CLIENT_ID/SECRET`, `FOOTBALL_DATA_API_KEY`, `TOKEN_ENCRYPTION_KEY`, `TOKEN_ENCRYPTION_KEY_PREVIOUS` (opcional, solo durante una rotación), `PUBLIC_APP_URL`, `ENVIRONMENT`), porque los secretos de Pages no se comparten (a verificar, S1). No requiere `ADMIN_SECRET` (no hay endpoint de por medio).

`TOKEN_ENCRYPTION_KEY` es obligatoria: el tick lee y refresca los tokens de calendario, que se guardan cifrados con AES-256-GCM en formato `enc:v1:...` (TDD 15). Sin la clave el Worker no puede descifrar ningún token, así que no puede sincronizar a nadie. Debe ser el mismo valor que en Pages; si difiere, el descifrado falla para todos los usuarios (ver S-05).

Alternativas descartadas:
- **Mantener GitHub Actions (`schedule`) y agregar un watchdog.** Es la opción más barata y la dejamos como **vigía** (D7), pero no como disparador: los retrasos de GitHub son habituales, el watchdog corre en la misma plataforma que quiere vigilar y la desactivación a los 60 días lo mataría a la vez. Un disparador debe ser el componente más confiable de la cadena, no el menos.
- **Servicio externo de cron (cron-job.org, EasyCron, etc.) que llame a `/api/admin/sync`.** Agrega un tercero con el `ADMIN_SECRET`, sin garantías ni versionado en el repo, y mantiene la limitación de que todo el lote corre en una request HTTP de Pages con el reloj del cliente. Descartado.
- **Migrar la app entera de Pages a Workers (con assets) para tener `scheduled()` en el mismo proyecto.** Resuelve todo en un solo despliegue pero es un cambio de plataforma grande (adaptador de Astro, rutas, `_routes.json`, dominios), fuera de alcance de este TDD. Queda como evolución posible.
- **Durable Object con alarmas.** Más preciso, pero introduce un recurso nuevo con estado y costo; el tick de cron alcanza.
- **Cloudflare Workflows / Queues.** Útiles para el escalado de 10.000 usuarios (D5, §6) pero innecesarias hoy.

### D2. El disparo corre código compartido, no un endpoint

`fisture-cron` llama a `runSync(env, "cron", { calendarAutoSync: true })` y a un nuevo `runCalendarTick`, **sin pasar por HTTP**. Se elimina el paso por `/api/admin/sync` para el cron (el endpoint queda para uso manual) y se borra `functions/scheduled.ts` (código muerto). Con esto B2 queda resuelta de raíz: el camino automático y el camino probado son el mismo.

### D3. Dos trabajos con ritmos distintos

El `scheduled()` corre cada 15 minutos y decide qué hacer según el estado en D1, no según la hora:

| Trabajo | Cuándo corre | Qué hace |
| --- | --- | --- |
| **Ligas** (`runSync` con ESPN) | Si no hay un run de ligas `success` de las últimas **20 h** y no hay otro `running` reciente; reintenta en cada tick hasta lograrlo | Sincroniza competencias y equipos, chequeos de consistencia, invalida el caché |
| **Calendarios** (`runCalendarTick`) | En **cada tick** | Atiende un lote de usuarios con trabajo pendiente (D4) y registra el resultado |

Por qué decidir por estado: es **autorreparable**. Si un tick falla o se salta, el siguiente lo recupera, sin depender de que "justo a las 9:00" haya corrido algo. El horario deja de importar y se elimina la ambigüedad "9:00 UTC = 6:00 Argentina". Para evitar solapes se usa un candado en D1 (fila con vencimiento) en vez de confiar en que dos ticks no coincidan (C-D3).

`sync_runs` gana la columna `kind` (`leagues` o `calendars`) para que los 96 ticks diarios no tapen el estado de las ligas. Retención: los runs de calendario sin trabajo no se registran (solo los que atendieron usuarios o fallaron), así que no hay 96 filas diarias vacías.

Alternativa descartada: un único cron diario a las 9:00 (replica el esquema actual con las mismas fallas: un solo intento por día, lote único).

### D4. Cobertura: "el menos atendido primero", con presupuesto de subrequests

Se reemplaza `reconcileCandidates` (B3) por una cola justa:

1. Nueva columna `users.calendar_reconciled_at` (epoch ms, nullable) con índice. Se actualiza **siempre** que se atiende a un usuario, haya tenido éxito o no.
2. Candidatos = usuarios elegibles (con filas `needs_update`/`failed` de partidos no jugados, o con auto-sync y partidos sin sincronizar) **ordenados por `calendar_reconciled_at` ascendente, con los `NULL` primero** (usuarios nuevos). Eso es una rotación por construcción: el último atendido pasa al final y nadie puede quedar relegado, sin necesidad de un cursor que mantener ni reiniciar.
3. El lote se corta por **presupuesto de subrequests** y no por usuarios: un contador (`budget`) suma cada consulta D1 y cada llamada al calendario; el tick se detiene cuando llega al **70 % del límite del plan** (Paid: 700 consultas D1 de las 1.000; es el límite que primero se agota, ver §4.1) o a 10 min de pared. El costo de cada partido se mide, no se estima (spike S3).
4. Un usuario cuya auth cae (un error de token: `invalid_grant`, falta de refresh token o de access token; no un 401 del proveedor, B4) pasa a `users.calendar_auth_status = 'reauth_required'` y **sale de la cola** hasta que vuelva a iniciar sesión (el login lo resetea). Esto libera lugar y da la métrica de "auth caída" (D6).
5. Un usuario con error transitorio (`rate_limit`, 5xx) se marca atendido y se reintenta en su próximo turno, con un tope de 3 turnos consecutivos antes de pasar al final con backoff de 6 h (columna `calendar_retry_after`, a decidir en el paso 3).
6. `CRON_MAX_USERS` desaparece; `CRON_MATCHES_PER_USER` pasa a ser un tope por turno (10) para que un solo usuario con 80 partidos no consuma el presupuesto, y el resto se atiende en turnos siguientes.

Alternativas descartadas:
- **Cursor persistente (`last_user_id`) en KV o D1.** Funciona, pero hay que reiniciarlo, no maneja bien usuarios nuevos (quedan detrás del cursor hasta la próxima vuelta) y reintentos priorizados. `calendar_reconciled_at` hace lo mismo con una sola columna y es consultable en la métrica de frescura.
- **Subir `CRON_MAX_USERS`.** Esconde el problema: sigue sin garantizar nada y no resuelve el orden.
- **Orden aleatorio.** Probabilísticamente justo, no acotado, no testeable.

### D4.1. Número de partidos y usuarios por tick (cálculo)

Costo estimado por usuario atendido (a verificar con el spike S3; sale de leer `syncMatches` y `reconcileCalendars`): por usuario ~5 consultas D1 fijas (usuario, preferencias, pendientes, auto-sync equipos y partidos) y por partido ~4 consultas D1 (detalle, fila existente, guardar estado, y refresco de token si vence) más 1 `fetch` al calendario.

| Perfil de usuario atendido | Consultas D1 + fetch | Usuarios por tick con presupuesto de 700 |
| --- | --- | --- |
| Sin trabajo real (auto-sync al día) | ~6 | ~115 |
| Típico (2 pendientes) | ~15 | ~46 |
| Peor caso (10 partidos, token vencido) | ~57 | ~12 |

Con ticks cada 15 min hay 96 ticks por día. Tiempo para recorrer a **todos** los usuarios elegibles (N):

| N usuarios elegibles | Típico (46 por tick) | Peor caso (12 por tick) | Veredicto |
| --- | --- | --- | --- |
| 100 | 3 ticks (45 min) | 9 ticks (~2 h) | Sobra |
| 1.000 | 22 ticks (~5,5 h) | 84 ticks (~21 h) | Cubre en menos de 24 h incluso en el peor caso |
| 10.000 | 218 ticks (~2,3 días) | 834 ticks (~8,7 días) | **No alcanza con un solo Worker** |

Para 10.000: no todos los usuarios tienen trabajo cada día. Con un 10 % de usuarios con pendientes por día (1.000 usuarios) el caso típico vuelve a cubrirse en ~5,5 h. Pero si la proporción real es mayor, el plan de escalado (§6) es repartir cada tick en N invocaciones con una **Queue de Cloudflare** (cada mensaje = un lote de usuarios, con su propio presupuesto de subrequests y reintentos propios) o encadenar invocaciones de un Service Binding. Se decide con datos reales cuando la métrica `calendar.oldestWaitHours` (D6) supere el 50 % del objetivo; no se construye antes. Los números anteriores son una estimación para dimensionar, no una promesa: S3 los reemplaza con mediciones.

### D5. Qué queda fuera de este TDD y cuándo se activa

La **Queue de Cloudflare** (fan-out por lote) se difiere. Disparador: `calendar.oldestWaitHours > 12` sostenido tres días. Está en el §6 con su costo (requiere plan Paid y un recurso nuevo) para que la decisión sea informada.

### D6. Qué mide el sistema (frescura y cobertura)

`/api/health` y `/api/admin/status` agregan, **sin datos personales**:

- `sync.leagues`: estado del último run de ligas (reglas actuales, `SYNC_OK_MAX_AGE_MS` 26 h / `SYNC_DEGRADED_MAX_AGE_MS` 50 h, `health.ts:9-12`), ahora filtrado por `kind = 'leagues'`.
- `sync.calendars.oldestWaitHours`: horas desde el `calendar_reconciled_at` más viejo entre los usuarios elegibles con trabajo (la métrica de cobertura de D4). `ok` <= 6 h, `degraded` <= 24 h, `fail` > 24 h (umbrales a ajustar con S3).
- `sync.calendars.lastTickAt` y `lastTickAgeMinutes`: `fail` si pasaron más de 60 min (el cron está parado).
- `sync.calendars.reauthRequired`: cantidad de usuarios con auth caída, solo un número. No cambia el estado general (es del usuario, no del sistema), pero lo informa la alerta A-03 si supera un umbral.

Como `lastTickAt` se actualiza en cada tick, "el sync no corrió en X horas" se responde con datos del propio Worker.

### D7. Cómo se avisa: vigía en GitHub Actions + issue (una opción recomendada)

Un workflow `.github/workflows/vigia-sync.yml`, cada 3 horas y `workflow_dispatch`, que:

1. Hace `GET {PUBLIC_APP_URL}/api/health` con reintentos (3 intentos, 20 s de espera; el endpoint es público y de solo lectura).
2. Falla (`exit 1`) si `status` es `fail`, si `sync.leagues` es `fail`, si `sync.calendars` es `fail`, o si `reauthRequired` supera el umbral (A-03).
3. Si falla, **abre o actualiza un issue** etiquetado `alerta-sync` (con `gh issue`, permiso `issues: write`), con el resumen sin datos personales y el enlace al run; si ya está abierto, comenta una sola vez cada 24 h para no inundar. Cuando vuelve a estar sano, comenta y **cierra** el issue.

Por qué esta y no otra:
- Cero costo, cero cuentas nuevas, y el canal ya lo mira el dueño: GitHub **envía un email al dueño** cuando falla un workflow programado y notifica los issues nuevos.
- El umbral de 3 h es compatible con los retrasos habituales de `schedule`: la vigilancia solo tiene que enterarse en horas, no en minutos, de un problema que ya tiene tolerancia de 26 h.
- Separa los roles: **disparar** es del Worker (D1), **vigilar** es de GitHub. Para que fallen los dos a la vez tendrían que caer Cloudflare y GitHub.

Punto débil aceptado: si el repo queda sin actividad 60 días, GitHub desactiva todos los workflows programados a la vez (el keepalive también) y no avisa. Mitigaciones: (a) el deploy y los PRs lo reactivan, (b) el propio vigía comenta en el issue "keepalive" mensual con `gh api` solo si no hay otra actividad (a decidir en el paso 6), (c) **opcional**: un monitor externo gratuito sobre `/api/health` (por ejemplo UptimeRobot, que alerta ante un 503) como red de seguridad independiente de GitHub. Esta última queda a decisión del dueño (§8); no es parte del camino mínimo.

Alternativas descartadas:
- **Email desde el Worker con Cloudflare Email Service.** Atractivo (avisa sin depender de GitHub) pero **no confirmamos** requisitos, costo ni si aplica sin dominio propio (la app vive en `fisture.pages.dev`; S5). Se reabre si S5 sale bien.
- **Slack/Discord/Telegram por webhook.** Requiere crear la cuenta y guardar otro secreto; el email de GitHub ya cubre lo mismo.
- **Solo monitor externo (UptimeRobot, Better Stack).** Detecta caídas del sitio, pero `/api/health` hoy puede estar en `degraded` (HTTP 200) con el sync atrasado; necesita el texto del cuerpo (palabra clave) y suele ser de pago. Sirve como red extra (opcional), no como alerta principal.
- **Que el Worker se auto-vigile (un segundo `scheduled()` que alerta).** Si el Worker no corre, tampoco alerta: no sirve para el modo de falla principal.
- **Cloudflare Notifications / Health Checks.** Posibles; **a verificar** (S5) si cubren Pages en el plan actual. Se reevalúa tras el spike.

### D8. Compatibilidad con el smoke del deploy (B9)

El smoke post-deploy deja de exigir `checks.sync` verde: acepta cualquier valor de `sync` y verifica solo `db` y `kv`. La salud del sync la vigila el vigía (D7), no el deploy. Así un sync caído nunca bloquea el deploy que lo arregla. Se cambia en `scripts/production-smoke.mjs` junto con su test.

### D9. Migración del cron de GitHub

`sync-cron.yml` **no se borra de golpe**: tras el despliegue del Worker pasa a modo `workflow_dispatch` solamente (se quita `schedule`), como disparador manual de emergencia. Se borra del todo cuando el Worker lleve 14 días sin incidentes. Así hay un camino manual conocido y se evita que dos disparadores corran a la vez.

## 5. Casos a cubrir

Convención de IDs: `T-` disparo y ticks, `C-` cobertura, `A-` alertas, `S-` seguridad y operación.

### Disparo y ticks (D1 a D3)

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| T-01 | `scheduled()` sin ningún run de ligas previo | Corre ligas y calendarios; registra `sync_runs` `kind=leagues` |
| T-02 | Último run de ligas `success` de hace 21 h | Corre ligas |
| T-03 | Último run de ligas `success` de hace 5 h | No corre ligas; sí el tick de calendarios |
| T-04 | Run de ligas `failed` hace 15 min | Reintenta ligas en este tick |
| T-05 | Run de ligas `running` hace 2 min (otro tick en curso) | No lanza otro (candado) |
| T-06 | Run `running` de hace 15 min (Worker murió, `RUN_HUNG_AFTER_MS`) | Lo da por colgado, libera el candado y corre |
| T-07 | Dos ticks simultáneos | Solo uno toma el candado; el otro termina sin hacer nada y lo registra |
| T-08 | Tick sin usuarios con trabajo | No registra run vacío, solo actualiza `lastTickAt` |
| T-09 | D1 caída durante el tick | La excepción se registra con `rootLogger`; el siguiente tick reintenta |
| T-10 | `ENVIRONMENT`, `TOKEN_ENCRYPTION_KEY` o secretos faltantes en el Worker | El tick falla con un error claro y `lastTickAt` **no** avanza (la alerta lo detecta) |

### Cobertura de usuarios (D4)

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| C-01 | 100 usuarios elegibles, presupuesto para 30 por tick | En 4 ticks todos tienen `calendar_reconciled_at` actualizado |
| C-02 | Un usuario con eventos `failed` permanente y 25 usuarios más con trabajo | El usuario con fallo no desplaza a los demás: todos se atienden antes de que él repita |
| C-03 | Usuario nuevo (`calendar_reconciled_at` nulo) | Se atiende en el primer tick, antes que los ya atendidos |
| C-04 | Usuario con auto-sync y 0 pendientes | Se atiende por rotación, nunca queda siempre último (corrige B3) |
| C-05 | El presupuesto se agota en medio de un usuario | Se cierra el usuario en curso, el resto queda para el siguiente tick, sin marcarlos como atendidos |
| C-06 | Usuario con 40 partidos pendientes | Se atienden 10 por turno (`CRON_MATCHES_PER_USER`); los restantes en turnos siguientes; no monopoliza |
| C-07 | Token revocado (`invalid_grant`, sin refresh o access token) | `calendar_auth_status = 'reauth_required'`, sale de la cola, las filas no pasan a `failed` (consistente con D4 del TDD 11) |
| C-08 | El usuario reinicia sesión tras `reauth_required` | El estado vuelve a `ok` y reentra en la cola |
| C-09 | `rate_limit` del calendario | El usuario se corta, se marca atendido, reintenta en su próximo turno con backoff |
| C-10 | Usuarios eliminados durante el lote | Se omiten sin error |
| C-11 | El conteo del presupuesto | Cada consulta D1 y cada llamada al calendario suma 1; con presupuesto N el tick hace como máximo N operaciones (test con contador sobre una D1 instrumentada) |
| C-12 | Orden estable ante empates | Mismo `calendar_reconciled_at` se desempata por `id`, determinista |

### Alertas y salud (D6, D7)

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| A-01 | Último `success` de ligas > 26 h | `sync.leagues = degraded`; > 50 h `fail`; el vigía falla |
| A-02 | Último run de ligas `failed` o `partial` | `fail` / `degraded` según reglas existentes; el vigía falla en `fail`; dos `partial` seguidos abren issue |
| A-03 | `reauthRequired` supera max(5, 10 % de usuarios elegibles) | El vigía lo informa en el issue (no cambia `status`) |
| A-04 | `lastTickAt` con más de 60 min | `sync.calendars = fail` |
| A-05 | `oldestWaitHours` > 24 | `sync.calendars = fail` |
| A-06 | `/api/health` no responde o devuelve 5xx | El vigía reintenta 3 veces y luego falla |
| A-07 | Falla repetida durante varios días | Un solo issue abierto, un comentario cada 24 h (sin spam) |
| A-08 | Se recupera | El vigía comenta y cierra el issue |
| A-09 | `/api/health` no filtra datos personales | La respuesta solo trae estados y números agregados (test de forma de la respuesta) |
| A-10 | Smoke del deploy con `sync = fail` | El smoke pasa (D8) y el deploy no se bloquea |

### Seguridad y operación

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| S-01 | `fisture-cron` no expone rutas HTTP | Su `fetch` responde 404; no hay endpoint que dispare el sync |
| S-02 | Logs del Worker | Sin tokens ni correos; los títulos de eventos ajenos siguen sin loguearse (consistente con el TDD 11) |
| S-03 | El workflow de vigía no usa `ADMIN_SECRET` | Solo lee `/api/health` público |
| S-04 | Dos disparadores a la vez (Worker y `workflow_dispatch` manual) | El candado de T-07 lo cubre |
| S-05 | Falta `TOKEN_ENCRYPTION_KEY` en el Worker, o no descifra un token existente (clave distinta a la de Pages) | Error explícito y registrado con `rootLogger` (código distinguible, sin el valor del token); `lastTickAt` **no** avanza; el usuario **no** pasa a `reauth_required` ni se trata como "sin tokens": es un fallo de configuración, no de la cuenta. Ningún token se escribe sin cifrar |

## 6. Escalado más allá de 1.000 usuarios

Disparador medible: `sync.calendars.oldestWaitHours` por encima de 12 durante tres días seguidos. Opciones, de menor a mayor costo:

1. Subir la frecuencia del cron a cada 5 minutos (3x capacidad; el límite de CPU de cron en Paid para intervalos menores a 1 h es de 30 s, **a verificar** si alcanza con el tick medido, S2).
2. **Queue de Cloudflare**: el tick solo encola lotes de usuarios y N consumidores procesan en paralelo, cada uno con su propio presupuesto. Requiere Paid y un recurso nuevo; es la opción de 10.000+ usuarios.
3. Reducir el costo por usuario: pedir a Google/Microsoft cambios incrementales (a investigar) o hacer el refresco de token fuera del lote.

## 7. Estrategia de tests (test primero: rojo, verde, refactor)

Reglas generales (iguales al TDD 10, 11 y 12):

- Todo test se escribe y se ve **fallar (rojo)** antes de implementar; luego el mínimo código para **verde**; después refactor con la suite en verde.
- Reloj fijo de `tests/helpers/clock.ts` (`relojFijo`, `AHORA`, `HORA_MS`) en todos los tests con fechas; solo se simula `Date`, los timers reales los necesita Miniflare.
- D1 efímera con Miniflare (`tests/helpers/d1.ts`, `use-test-db.ts`); proveedores de calendario y de datos **inyectados** (`SyncDeps`, `RunSyncDeps`); sin red.

| Capa | Dónde | Qué prueba |
| --- | --- | --- |
| Unit | `tests/unit/` | Funciones puras: decisión "¿corre ligas?" (T-01 a T-06), reglas de salud (A-01, A-02, A-04, A-05), presupuesto (C-11), orden de candidatos (C-12) |
| Integración (D1 Miniflare) | `tests/integration/` y `tests/observability/` | Cola justa con N usuarios simulados (C-01 a C-10), candado (T-05 a T-07), `runCalendarTick` completo con cliente de calendario falso, esquema y migración nuevos |
| Handler del Worker | `tests/integration/cron-worker.test.ts` | `scheduled()` con `env` de Miniflare y `ctx` falso (T-01, T-08 a T-10, S-01) |
| Workflow del vigía | `scripts/vigia-sync.mjs` + `tests/unit/` | La lógica del vigía vive en un script Node **probable** (lee un JSON de salud, decide, arma el texto del issue): A-03, A-06 a A-09 sin depender de GitHub |
| Smoke | `scripts/production-smoke.mjs` | A-10 |

Cómo se prueba cada alerta (A-01 a A-10):
- La decisión "alerta sí/no" es **una función pura** sobre el JSON de `/api/health` (`evaluateWatch(health, now)`), con tablas de casos en un test unitario (rojo primero).
- El armado del issue (deduplicación, comentario cada 24 h, cierre) es lógica en `scripts/vigia-sync.mjs` con un cliente de `gh` inyectado y probado con un doble.
- **Prueba de punta a punta una sola vez, manual** en el paso 7: se ejecuta el vigía con `workflow_dispatch` apuntando a un `HEALTH_URL` alternativo que devuelve `fail` (un Worker o archivo estático de prueba) y se verifica que llegan el issue y el email de GitHub; luego se devuelve a `ok` y se verifica el cierre.

Casos manuales y spikes (no automatizables): S1 a S7 del §9.

Umbrales de cobertura: los de `vitest.config` se mantienen; el código nuevo debe quedar dentro de ellos sin bajarlos. Se agrega el directorio `workers/cron/` al descubrimiento de tests (`scripts/check-test-discovery.mjs`) si hace falta.

## 8. Despliegue y rollback

### Qué cambia en infraestructura

| Cambio | Quién | Cuándo |
| --- | --- | --- |
| Confirmar el **plan de Cloudflare** (Free o Paid). Si es Free, activar Workers Paid (USD 5/mes) | Dueño de la cuenta | Antes de implementar (S1) |
| Crear el token de API con permiso de **Workers Scripts: Edit** (además de Pages y D1 que ya tiene `CLOUDFLARE_API_TOKEN`) | Dueño | Antes del paso 5 |
| Cargar los **secretos del Worker** `fisture-cron` (`wrangler secret put` o por el dashboard): `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `FOOTBALL_DATA_API_KEY`, `TOKEN_ENCRYPTION_KEY` y, solo si hay una rotación en curso, `TOKEN_ENCRYPTION_KEY_PREVIOUS` | Dueño (los valores) | Antes del primer deploy del Worker |
| Checklist de secretos antes del deploy del Worker: `TOKEN_ENCRYPTION_KEY` existe en Pages y en `fisture-cron` con el **mismo** valor (`wrangler secret list` confirma la presencia; el valor se verifica con un descifrado de prueba en el paso 4). Si falta o difiere, no se despliega | Dueño y implementación | Antes del paso 5 |
| Habilitar `issues: write` para el workflow del vigía y crear la etiqueta `alerta-sync` | Dueño o implementación con permiso del dueño | Paso 6 |
| Migración D1: `sync_runs.kind`, `users.calendar_reconciled_at`, `users.calendar_auth_status`, `users.calendar_retry_after`, tabla de candado, índices | Automática en `deploy.yml` (`d1 migrations apply`) | Con el release |
| Decidir si se agrega el monitor externo opcional (UptimeRobot, gratis) | Dueño | A discreción |
| Revisar que las notificaciones de GitHub por fallo de workflow estén activas en la cuenta | Dueño | Paso 7 |

### Orden de despliegue

1. Release 1 (compatible hacia atrás): migración D1 (columnas nulas con valores por defecto), código de cola justa y métricas en `/api/health`. El cron de GitHub sigue disparando. Nada cambia para el usuario.
2. Despliegue del Worker `fisture-cron` con `deploy.yml` (nuevo paso `wrangler deploy -c workers/cron/wrangler.toml`, después de las migraciones y del deploy de Pages). Los dos disparadores conviven un día; el candado (T-07) evita solapes.
3. Se quita el `schedule` de `sync-cron.yml` (D9) y se activa el vigía.
4. A los 14 días sin incidentes: se elimina `sync-cron.yml`.

### Rollback

- El Worker se puede **pausar sin tocar código**: quitar el trigger (`wrangler triggers` o vaciar `crons` y redeployar) o `wrangler delete` del Worker. El `workflow_dispatch` de `sync-cron.yml` sigue disponible como disparo manual de emergencia; volver a poner el `schedule` es un commit.
- Las migraciones son aditivas (columnas nulas, tablas nuevas); el rollback de código **no las revierte** y no hace falta (ver `docs/13-testing-y-release.md`).
- Si la cola justa se comporta mal, el flag de entorno `CALENDAR_TICK_ENABLED = "false"` en el Worker deja correr solo las ligas (a implementar en el paso 4).
- Un deploy de Pages fallido no afecta al Worker y viceversa: son artefactos independientes.

## 9. Plan de implementación por pasos

Cada paso termina en verde (`npm run check`) y es un commit atómico (formato Conventional Commits en español, <= 50 caracteres en el título). Rama de trabajo desde `development`; PR a `development` con Squash and merge.

**Paso 0, spikes (sin código de producción, resultado anotado en §12):**
- **S1**: confirmar el plan (Free/Paid) y que un Worker de prueba puede enlazar la **misma** D1 y KV de producción; confirmar que los secretos hay que cargarlos aparte. Resultado: sí/no y costo.
- **S2**: en un Worker de prueba con cron, medir si un cron cada 15 min recibe el límite de CPU de "menos de 1 h" (30 s) y confirmar la duración de pared; decidir cadencia.
- **S3**: medir en una D1 local o de staging las consultas D1 y `fetch` reales por usuario y por partido (instrumentar la D1 con un contador) para reemplazar la tabla del §4.1.
- **S4**: confirmar que `wrangler deploy` empaqueta `import ... from "../../src/lib/..."` (esbuild) y que `drizzle-orm` y las utilidades de Arctic funcionan en el bundle del Worker (sin APIs de Node no soportadas).
- **S5**: confirmar si Cloudflare Email Service o Cloudflare Notifications sirven para alertar sin dominio propio y su costo. Si es sí y sin costo, se reevalúa D7 como canal adicional; no cambia el camino mínimo.
- **S6**: ver qué hace el build de Pages con `functions/scheduled.ts` (¿ruta `/scheduled`?).
- **S7**: consultar `GET /api/admin/status` y los logs de producción para confirmar B2 (si algún calendario se corrigió alguna vez por el cron de GitHub) y el estado real de `sync_runs`.

**Paso 1, esquema y salud (rojo, verde, refactor).** Tests de A-01 a A-05, A-09. Migración (`sync_runs.kind`, columnas de usuario, candado). Separar la salud por `kind` y agregar las métricas del D6. Sin cambio de comportamiento del sync.

**Paso 2, cola justa.** Tests C-01 a C-12. Reemplazar `reconcileCandidates` por el orden por `calendar_reconciled_at`, el presupuesto de subrequests (D1 instrumentable) y el estado `reauth_required`. Eliminar `CRON_MAX_USERS`. Resetear `reauth` en el login.

**Paso 3, `runCalendarTick` y candado.** Tests T-01 a T-08. Función que decide qué corre (ligas y/o calendarios), toma el candado, registra el run y actualiza `lastTickAt`. Reintentos con backoff (C-09).

**Paso 4, Worker `fisture-cron`.** Tests de handler (T-09, T-10, S-01, S-05). `workers/cron/` con su `wrangler.toml` y `scheduled()`; flag `CALENDAR_TICK_ENABLED`; borrar `functions/scheduled.ts`.

**Paso 5, deploy.** Paso nuevo en `deploy.yml` (`wrangler deploy` del Worker), ajuste del smoke (D8, test A-10), prueba del deploy en `development` con `wrangler deploy --dry-run` en el CI. Habilitar permisos del token (dueño).

**Paso 6, vigía.** Tests de `evaluateWatch` y del cliente de issues (A-03, A-06 a A-08). `scripts/vigia-sync.mjs` y `.github/workflows/vigia-sync.yml`; mitigación de los 60 días.

**Paso 7, puesta en marcha.** Prueba de punta a punta de la alerta (§7), quitar `schedule` de `sync-cron.yml` (D9), documentar en `CLAUDE.md` y `docs/09-competencias-y-sincronizacion.md` y `docs/08-deploy-infraestructura.md`; completar las notas de implementación.

## 10. Riesgos

| Riesgo | Probabilidad | Mitigación |
| --- | --- | --- |
| La cuenta es Free: con 50 subrequests el sync no cabe | Media (a verificar, S1) | Paid es de USD 5/mes; el TDD lo declara como requisito antes de implementar |
| Un Worker separado no puede compartir los secretos de Pages | Alta (esperable) | Cargarlos aparte (lista en el §8); documentarlo; checklist en el despliegue |
| Falta `TOKEN_ENCRYPTION_KEY` en `fisture-cron`, o no coincide con la de Pages: el cron no descifra ningún token y ningún usuario se sincroniza | Media | Está en la lista de secretos y en el checklist del §8 (no se despliega sin ella); el fallo es visible (S-05, T-10) y no se confunde con "sin tokens" ni con `reauth_required` |
| El bundle del Worker falla por dependencias de `src/lib` | Baja | S4 antes de escribir código |
| Costo real por partido mayor al estimado | Media | El presupuesto se mide en tiempo de ejecución (C-11), no se asume; S3 lo calibra |
| Dos disparadores a la vez durante la migración | Media | Candado en D1 (T-07) y convivencia corta (D9) |
| El vigía de GitHub se desactiva a los 60 días | Media | Mitigaciones (b) y (c) del D7; la deuda queda declarada |
| El email de GitHub por falla de workflow va a spam o está apagado | Media | Chequeo en el paso 7 y el issue como segundo canal |
| Falsos positivos de alerta por retrasos de GitHub | Media | Reintentos del vigía y umbral amplio (3 h frente a 26 h de tolerancia) |
| Más usuarios de los previstos por tick | Media | Métrica `oldestWaitHours` y plan de escalado del §6 |
| `calendar_reconciled_at` actualizado por usuarios sin trabajo infla escrituras en D1 | Baja | Solo se escribe al atender; una escritura por usuario atendido |
| Cambiar de un solo cron diario a ticks frecuentes aumenta las requests de Workers | Baja | 96 invocaciones por día están muy por debajo de las cuotas |

## 11. Fuera de este documento (fases siguientes)

- Avisar al usuario (mail o aviso en la UI) cuando su calendario pasa a `reauth_required`.
- Queue de Cloudflare para fan-out (§6).
- Monitor externo adicional y canal de email del Worker, según S5.

## 12. Notas de implementación

Implementado el 2026-11-03 en la rama `feat/sync-confiable`. La cuenta sigue en Workers Free (50 subrequests por invocación), así que se tomó la opción más barata del propio TDD: GitHub Actions sigue siendo el disparador y el trabajo se parte en lotes que caben en una invocación. Es lo que `docs/22` D4 ya hacía para las ligas.

### Qué se implementó y dónde

| Tema | Implementación |
| --- | --- |
| B2, reconciliación en producción | `POST /api/admin/sync` acepta `{"calendarios": true, "corte": ms}` (`run-calendar-batch.ts`). El job `calendarios` de `sync-cron.yml` corre `scripts/sync-calendarios.mjs` después de las ligas y encadena lotes hasta `siguiente: false` (un barrido). |
| B3, rotación justa | `reconcileCalendarBatch` (`calendar/reconcile.ts`) ordena por `users.calendar_reconciled_at` ascendente, `NULL` primero, desempate por `id`. Se marca atendido a todo usuario atendido, haya andado o no. El `corte` del barrido evita repetir a nadie dentro del mismo barrido. Sin cursor aparte (D4). |
| B4, auth revocada | Solo un error de token (`invalid_grant`, falta de refresh token o de access token; `SyncResult.tokenInvalido`) pasa al usuario a `calendar_auth_status = 'reauth_required'`: sale de la cola y sus filas no pasan a `failed`. El callback OAuth lo devuelve a `ok` y lo pone primero en la cola. `metricas.calendariosSinAcceso` lo cuenta. |
| B5, tope por subrequests | `calendar/presupuesto.ts`: la D1 (`contarD1`) y el cliente de calendario (`contarCliente`) suman cada consulta y cada llamada. Presupuesto de 45 (50 menos margen), con 3 reservadas para registrar el run. Un lote no empieza un usuario sin lugar para su costo fijo (8), su token (4), un partido (6) y la reserva de un 401 (6), ni un partido sin lugar para su peor caso. Reemplaza `CRON_MAX_USERS`; `CRON_MATCHES_PER_USER` quedó como `PARTIDOS_POR_TURNO` (3 tras la revisión, ver abajo). |
| B6, salud separada | `sync_runs.kind` (migración 0011). `checks.sync` mide solo ligas; `checks.calendars` mide los runs de calendarios con las reglas de frescura de las ligas (26 h degraded) pero **como máximo `degraded`**: nunca `fail` (ver la revisión, I3). `/api/admin/status` trae `runs` (ligas) y `runsCalendarios`. |
| B1, disparo autorreparable | `keepalive.yml` (semanal) con `scripts/keepalive.mjs`: vuelve a habilitar con la API los workflows que GitHub desactivó por inactividad (`disabled_inactivity`; uno desactivado a mano no se toca) y abre un issue si reactivó alguno o si `sync-cron.yml` lleva más de 72 h sin un run exitoso. |
| Código muerto | Se borró `functions/scheduled.ts` y la opción `calendarAutoSync` de `runSync`, que solo él usaba. |

### Desvíos respecto del diseño del TDD

- **No se construyó el Worker `fisture-cron` (D1, D2, D3, §8)** ni sus ticks de 15 minutos, porque exigen Workers Paid y recursos nuevos. El disparo sigue siendo un `schedule` de GitHub, con el keepalive como mitigación. Sigue siendo la opción a evaluar cuando se pase a Paid (`docs/24` §3).
- **Sin candado en D1 ni `calendar_retry_after` (D3, D4.5).** No hay ticks concurrentes: un barrido por workflow, y dos barridos simultáneos son inocuos (cada usuario se marca atendido y el segundo lo salta si cae después del corte). Un usuario con error transitorio o `rate_limit` se marca atendido y vuelve a su turno en el próximo barrido; no hay backoff ni tope de 3 turnos.
- **La cola solo incluye usuarios con trabajo real.** El TDD ordenaba también a los de auto-sync sin pendientes (C-04). Se ajustó la consulta de candidatos para que un usuario con todo sincronizado no gaste lugar ni subrequests: hace falta un evento `needs_update`/`failed` sin jugar, o un partido futuro de un equipo con auto-sync sin alta.
- **`kind` sin columna `trigger` nueva.** Los runs de calendarios se registran de una vez (`registrarRunCalendarios`: un INSERT y la purga) en lugar de iniciar y cerrar el run, para gastar 2 consultas y no 4 del presupuesto. Todo lote registra su run, incluso el vacío que cierra el barrido (al menos uno por día), para que la frescura tenga un dato. Las alertas son los issues `incidente` del workflow, no un vigía aparte (D7): `sync-cron.yml`, `monitor.yml` y `keepalive.yml` ya cubren los casos.
- **Un run de calendarios es `partial` solo si un lote no alcanza para procesar ni un evento** (sin progreso), o si el barrido llega al máximo de lotes (40) con usuarios pendientes: en ese caso el script registra un run `partial` (POST con `incompleto` y el corte, sin hacer trabajo) además del `::warning::`, y `/api/health` muestra `calendars: degraded` hasta el próximo run exitoso. Un 401 de un usuario no degrada el sistema.
- **Sin runs de calendarios, `checks.calendars` es `ok`** (el TDD no definía este caso). Evita un falso 503 entre el deploy y el primer barrido; si el disparo no corre, ya falla el check de ligas.
- **Migración 0011 a mano**: `npm run db:generate` produce una migración contra el snapshot viejo (0000), que repite lo ya aplicado. Se tomaron de su salida las cinco sentencias nuevas, como en las migraciones 0001 a 0009. No hay `users.calendar_retry_after` ni tabla de candado (ver arriba).
- **El smoke del deploy (D8, B9) no se cambió**: sigue exigiendo `checks.sync` en `ok` o `degraded`. No mira `checks.calendars`.

### Costo medido y capacidad (reemplaza la estimación del §4.1 para este esquema)

Medido con la D1 de tests: un lote que atiende a 3 usuarios con un evento cada uno gasta 28 consultas D1 y 3 llamadas al calendario (31 con el presupuesto; 7 de ellas son fijas del primer lote: marcar desactualizados, candidatos y registrar el run). Es decir, unos 8 a 9 subrequests por usuario con un evento, y de 3 a 4 usuarios por lote. Con 40 lotes por barrido y 15 s de pausa (unos 12 minutos), el workflow atiende unos **120 a 160 usuarios con trabajo por día**; hay más margen porque la mayoría no tiene trabajo cada día. Palancas, de menor a mayor costo: un segundo `schedule` diario solo de calendarios, subir `maxLotes`, y pasar a Workers Paid (1.000 subrequests: ~100 usuarios por lote). La señal para actuar es el `::warning::` de barrido incompleto en el log de `sync-cron.yml` varios días seguidos.

### Correcciones de la revisión (2026-11-03) y integración con docs/18

- **B1, progreso parcial.** Un usuario cortado por presupuesto a mitad de turno dejaba el lote con `usuarios: 0`: el run quedaba `partial` con `siguiente: true`, el script lo leía como "sin progreso" y salía con error (issue de incidente), y al no marcarse atendido el usuario volvía primero todos los días. Ahora el progreso se mide por eventos procesados: con alguno el usuario se marca atendido y rota; con ninguno no se lo marca y el lote es `partial`. `PARTIDOS_POR_TURNO` bajó de 10 a 4 para que el peor caso entre en un lote: costo fijo del usuario 8 (pendientes, equipos, partidos, hasta 3 consultas de estados, preferencias, marcarlo), token 4 (identidad, llamada, doble escritura de docs/18 D6), partido 6 (detalle, fila, estado y 3 llamadas por el alta con adopción en Google: insert, 409 y get, y update o restore; corregido en la segunda revisión, antes se contaban 2 y el costo era 5) y reserva de 6 para un 401. Los `needs_update` van antes que los `failed` que se reintentan a diario: un evento que falla siempre ya no ocupa todos los turnos de su usuario. El test de tope por turno (C-06) usa la D1 instrumentada, y hay un test de punta a punta del barrido (script contra el handler y una D1 real) con un usuario de muchos pendientes y otro con fallas permanentes.
- **I1, token por invocación.** `syncMatches` obtiene el token una sola vez (antes, uno por partido: con el token vencido renovaba en cada uno, con el refresh token ya rotado). `getValidAccessToken` actualiza el `user` en memoria tras renovar.
- **I2, 401.** Un 401 fuerza una renovación y reintenta una vez; solo si la renovación falla (`invalid_grant`) o no hay refresh token (errores de token) el usuario queda `reauth_required`. Un 401 que persiste tras la renovación (se renueva una vez por invocación) no lo marca: puede ser un fallo transitorio del proveedor, así que las filas quedan pendientes y se reintentan al día siguiente. Antes cualquier `code === "auth"` lo sacaba de la cola, y una cuenta sana con un 401 transitorio quedaba fuera sin aviso. Solo el 401 reintenta: un error transitorio nunca reintenta ni crea un evento nuevo.
- **I3.** `checks.calendars` nunca pasa de `degraded`: con `fail`, `/api/health` respondía 503 y `production-smoke` bloqueaba deploys, incluido el que lo arregla.
- **Segunda revisión (PR #54).** (1) `reauth_required` solo por errores de token, ver I2 (test: partido 1 con 401 que renueva y funciona, partido 2 con 401 otra vez, el usuario sigue en `ok`). (2) `contarCliente` cuenta `create` como 3 y `COSTO_MAX_PARTIDO` pasa a 6, por lo que `PARTIDOS_POR_TURNO` baja a 3: 5 (primer lote) + 8 + 4 + 6 (401) + 3 x 6 = 41 de 42. (3) La búsqueda de partidos de `candidatos` ya estaba acotada por `m.date_time` (desde hace `HORAS_PARTIDO_JUGADO` y desde ahora, respectivamente) y las columnas de equipo tienen índice; no se cambió la consulta y la estimación de filas leídas está en docs/24 §5. (4) `sync-cron.yml` tiene `concurrency` (`sync-diario`, sin cancelar el que corre). (5) Aclaración del keepalive en docs/23.
- **M1.** El keepalive solo reactiva `disabled_inactivity`. **M5.** Un alta o cambio manual exitoso devuelve a `ok` a un usuario en `reauth_required`.
- **Integración con docs/18** (rebase sobre `feat/vinculacion-de-cuentas`, migración 0010 de identidades): esta migración pasó a `0011`. `getValidAccessToken` hace una consulta más (la identidad) y la renovación escribe dos sentencias (identidad y `users`). El presupuesto ya no mira `users.tokenExpiresAt` para saber si se renueva: `getValidAccessToken` avisa con un callback (`alRenovar`) justo antes de la llamada al proveedor, así que sigue siendo correcto cuando se borren las columnas `users.*` en el release N+1. El reset a `ok` del login vive en `registrarLogin` (`auth/identity.ts`): corre cuando entra o se vuelve a vincular la identidad del proveedor de calendario activo, el único caso en que llegan tokens nuevos del calendario. No hay en docs/18 un flujo para cambiar el proveedor activo.

### Casos del §5 cubiertos

C-01 a C-09 y C-11, C-12 en `tests/integration/calendar/reconcile.test.ts` y `tests/observability/run-calendar-batch.test.ts` (C-10 no aplica: los candidatos salen de la tabla `users`); C-08 también en `callback.test.ts`; A-01, A-02, A-04 y A-05 como reglas de frescura en `health.test.ts` y `health-calendarios.test.ts` (A-04 y A-05 se reducen a la frescura del último run de calendarios); A-09 en `health.test.ts`. T-xx, S-01, S-05 y A-03, A-06 a A-08, A-10 no aplican: eran del Worker, del vigía o del cambio del smoke que no se hicieron.

### Pendiente y a verificar

- **Keepalive: no se pudo verificar desde el código** que `PUT .../actions/workflows/{id}/enable` sobre un workflow activo reinicie el plazo de 60 días. La inactividad desactiva **todos** los workflows programados del repo a la vez, `keepalive.yml` incluido, así que reactivar ante `disabled_inactivity` sirve de poco: quien reactivaría ya está apagado. Lo que protegería es que el `PUT .../enable` reinicie el plazo de 60 días, y eso sigue sin verificarse. Si GitHub desactiva todos a la vez, nada los reactiva: el respaldo independiente es un monitor externo sobre `/api/health` (UptimeRobot u otro, gratuito), **a decisión del dueño** (docs/23 §6). Para comprobarlo: lanzar `keepalive.yml` a mano con *Run workflow* y ver que termina en verde.
- **Clasificación del 403 `insufficientPermissions` de Google: pendiente.** Hoy `classifyCalendarError` lo trata como `permanent` (la fila queda `failed` y se reintenta a diario) y no como falta de acceso. No se cambió en la segunda revisión; hay que decidir si debe contar como fallo de auth (el usuario retiró el permiso del calendario).
- **Spikes S1 a S5 y S7 no se hicieron** (eran del Worker). **S6**: `functions/scheduled.ts` se borró sin más; Pages ya no tiene un directorio `functions/`.
- **Despliegue**: la migración 0011 corre sola en `deploy.yml`. No hay variables ni secrets nuevos (se usan `PUBLIC_APP_URL` y `ADMIN_SECRET` del workflow y los OAuth de Pages). Después del release conviene lanzar **Sync diario** a mano una vez (Actions → *Run workflow*) y mirar `runsCalendarios` en `/api/admin/status`. El token del workflow `keepalive.yml` usa `actions: write`: no requiere un secret.
- **Fuera de alcance, sin cambios**: avisar al usuario cuando su calendario pasa a `reauth_required` (§11) y la Queue de Cloudflare (§6).
