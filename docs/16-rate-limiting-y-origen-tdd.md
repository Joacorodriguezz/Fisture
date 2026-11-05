# TDD: Rate limiting y verificación de origen en la API

> Technical Design Document. Estado: **implementado** (2026-11-05, rama `feat/rate-limiting-y-origen`). Redactado el 2026-10-22. Los desvíos respecto del diseño y lo verificado en la documentación de Cloudflare están en el §13.
>
> Este documento registra **qué problemas hay hoy, qué decidimos y por qué**. El código y los tests se escribieron después de la aprobación, siguiendo el orden del §10.
>
> Dependencias de numeración: este TDD asumía que `docs/14-borrado-de-cuenta-tdd.md` (que prevé `esMismoOrigen`) y `docs/15-cifrado-de-tokens-tdd.md` existían en `development` al implementar. Al implementar, `esMismoOrigen` ya estaba en `lib/auth/guards.ts` (docs/14); se generalizó ahí mismo (D6). La migración es la `0013` (la `0011` y la `0012` estaban reservadas a otros PRs).

## 1. Contexto y problema

Hoy FISTURE se usa entre pocas personas. Antes de abrirlo al público, la API de `src/pages/api/**` está expuesta sin ninguna defensa contra abuso:

| # | Brecha | Dónde | Consecuencia |
| --- | --- | --- | --- |
| R1 | No hay límite de tasa en ningún endpoint | todo `/api/*` | Un script puede disparar miles de requests por minuto contra D1 y las APIs de Google/Microsoft |
| R2 | `POST /api/calendario/sync` acepta `matchIds` sin tope de cantidad ni de frecuencia | `calendario/sync.ts` | Un usuario (o una sesión robada) escribe cientos de eventos en un calendario ajeno y agota la cuota de la API de Google/Microsoft de la app entera |
| R3 | `/api/auth/login/*` y `/api/auth/callback/*` sin límite | `auth/` | Inundación de `state` en KV y de intentos de intercambio de código |
| R4 | `/api/admin/*` con Bearer: los fallos no se cuentan | `admin-auth.ts` | Fuerza bruta de `ADMIN_SECRET` sin freno |
| R5 | `/api/equipos/buscar` es público y hace `LIKE '%q%'` | `equipos/buscar.ts` | Barrido de la tabla `teams` y consumo de lecturas de D1 por cualquiera |
| R6 | Los métodos que mutan estado no verifican `Origin` ni `Sec-Fetch-Site`; la cookie es `sameSite=lax` | `auth/callback/[provider].ts:107` | `lax` protege los POST cross-site de forma indirecta, pero no los `DELETE` ni `PUT` en navegadores o escenarios con particularidades (subdominios, `same-site` distinto de `same-origin`), y un `fetch` con `Content-Type: text/plain` evita el preflight |
| R7 | No se valida `Content-Type` | handlers que hacen `request.json()` | Un "simple request" cross-origin con cuerpo JSON y `text/plain` llega al handler sin preflight |
| R8 | No hay forma de ver si algo se está bloqueando | observabilidad | Un límite mal calibrado bloquearía usuarios legítimos sin que nadie se entere |

Referencia de seguridad existente: los endpoints con sesión ya devuelven 401 sin usuario (`decidirAcceso`) y los logs enmascaran datos sensibles (`logger.ts`).

## 2. Objetivos y no objetivos

**Objetivos**

1. Cada endpoint tiene un límite de tasa explícito, por usuario (sesión) y/o por IP, con valores justificados (§5.3).
2. Las requests que mutan estado y llevan cookie de sesión solo se aceptan desde el propio origen de la app, y con `Content-Type: application/json` cuando traen cuerpo.
3. Un solo punto de aplicación (`withApi`), declarativo por ruta, sin duplicar lógica en cada handler.
4. 429 con `Retry-After`; logs sin IP ni datos personales; bloqueos visibles en `GET /api/admin/status`.
5. Apagable en minutos (variable de entorno) si bloquea usuarios legítimos.
6. Cada caso del §6 tiene un test escrito **antes** de la implementación.

**No objetivos**

- Defensa contra DDoS de capa 3/4/7 volumétrico: lo absorbe Cloudflare por defecto. Esto limita abuso de la lógica de aplicación, no ataques masivos.
- CAPTCHA / Turnstile (§12: fase siguiente si hay abuso de registro).
- Dominio propio y reglas del WAF (se evalúan en D3, pero no son requisito; ver §3).
- Limitar las páginas `.astro` (solo `/api/*`). Los assets estáticos no pasan por Functions.
- Límite global estricto: aceptamos aproximación (§5.2).

## 3. Opciones técnicas investigadas

Estado de verificación: se consultó la documentación de Cloudflare el 2026-10-22. Lo que la documentación no confirma se marca **a verificar** y tiene su spike en el §10 (paso 0).

| Opción | Lo confirmado | Contras / límites reales | Veredicto |
| --- | --- | --- | --- |
| **O1. Reglas de rate limiting del WAF** | Las reglas se crean "para una zona" (tu dominio). Plan Free: 1 regla, contar por IP, período máx. 10 s, mitigación máx. 10 s. Pro: 2 reglas, 1 min. Business: 5 reglas. | La documentación **no menciona `pages.dev`**: no se pudo confirmar que apliquen en `*.pages.dev` (a verificar; lo esperable es que no, porque la zona `pages.dev` no es nuestra). Con 1 regla y 10 s no cubre usuario ni endpoints distintos. Fuera de la app: no sabe de sesión ni de usuario. | Descartada como mecanismo principal. Complemento opcional si se adopta dominio propio (D3). |
| **O2. Binding `ratelimit` de Workers** | Se declara con `[[ratelimits]]` (`name`, `namespace_id`, `[ratelimits.simple] limit/period`); requiere Wrangler >= 4.36.0. `period` solo 10 o 60 s. El conteo es **por ubicación de Cloudflare**, usa un contador local en caché con actualización en segundo plano: es aproximado y eventualmente consistente. La documentación desaconseja usar IP como clave. No es visible en el dashboard. | La lista de bindings soportados por Pages Functions (KV, DO, R2, D1, Vectorize, AI, service, queues, Hyperdrive, Analytics Engine) **no incluye `ratelimit`**: disponibilidad en Pages **a verificar** (spike S1). Solo ventanas de 10 s o 60 s: no sirve para "10 intentos de login por 10 minutos" ni "5 fallos de admin por 15 minutos". Sin métricas propias. | Descartada como principal por la ventana fija de 10/60 s y la incertidumbre en Pages. Candidata para reemplazar el backend en el futuro (§12), por eso la interfaz es intercambiable. |
| **O3. Contadores en KV** | Eventualmente consistente. Límite de 1 escritura por segundo a la misma clave. Plan Free: **1.000 escrituras/día** y 100.000 lecturas/día. | Un `get`+`put` no es atómico: bajo concurrencia se cuelan requests. 1.000 escrituras/día se agotan con unos pocos usuarios; ya usamos KV para sesiones y `state` de OAuth, así que además competiríamos con ellas. | Descartada. |
| **O4. Contadores en D1** | Una sola sentencia `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` es atómica: cuenta exacta y global, sin ubicación. Plan Free: 100.000 filas escritas/día y 5 millones leídas/día (el plan efectivo de la cuenta **a verificar**, S3). Funciona igual en Miniflare, así que es testeable con la D1 efímera de la suite. Ya está enlazada (`DB`). | Cada request limitada cuesta una escritura (más la del índice si la tabla no es `WITHOUT ROWID`) y una ida a D1 (latencia). Bajo ataque, los intentos bloqueados también escribirían: hay que acotarlo (D2). Requiere limpieza periódica. | **Recomendada**, aplicada solo donde el costo se justifica (§5). |
| **O5. Durable Objects** | La documentación de Pages indica que Pages Functions pueden **enlazar** Durable Objects, pero la clase debe vivir en un **Worker separado** desplegado aparte (la página muestra `--do BINDING=Clase@worker` para local). La sintaxis exacta en `wrangler.toml` de Pages no figura en esa página (a verificar, S2). | Es la opción técnicamente más correcta (contador global y atómico por clave), pero obliga a crear, desplegar y versionar un segundo Worker, a cambiar `deploy.yml` y a sumar un modo de test (Miniflare con dos scripts). Desproporcionado para el volumen actual. | Descartada por ahora; es la ruta de escalado si D1 se queda corto (§12). |
| **O6. Memoria del isolate** | Disponible siempre, cero costo. | No se comparte entre isolates ni ubicaciones; se reinicia sin aviso. Solo "mejor esfuerzo". | Usada **solo** para lecturas públicas baratas (D4), no para nada que proteja escrituras. |

## 4. Decisiones

### D1. Contadores en D1 con ventana fija, detrás de una interfaz `RateLimiter`

**Qué.** Tabla `rate_limits` y una función `hit(bucket, subject, {limit, windowSec}, now)` que ejecuta en una sola sentencia:

```sql
INSERT INTO rate_limits (bucket, subject, window_start, count)
VALUES (?1, ?2, ?3, 1)
ON CONFLICT (bucket, subject, window_start) DO UPDATE SET count = count + 1
RETURNING count;
```

`window_start = floor(now / windowMs) * windowMs`. Si `count > limit`, se bloquea; `Retry-After = window_start + windowMs - now` (redondeado hacia arriba, en segundos, mínimo 1).

**Por qué.** Es la única opción confirmada, exacta y atómica que ya está enlazada, no requiere un segundo Worker y se prueba en Miniflare. Ventana fija (no deslizante) porque es una sola escritura; el borde de ventana permite ráfagas de hasta 2x el límite, que aceptamos.

**Alternativas descartadas.** O1, O2, O3, O5 (ver §3). Ventana deslizante con log por request: N escrituras por ventana.

**Esquema** (migración `0007_rate_limits.sql`, escrita a mano porque Drizzle no expresa `WITHOUT ROWID`; la numeración se ajusta a la última migración existente al implementar):

```sql
CREATE TABLE rate_limits (
  bucket       TEXT NOT NULL,     -- p. ej. 'calendar_sync:user', 'login:ip'
  subject      TEXT NOT NULL,     -- id de usuario o hash de IP
  window_start INTEGER NOT NULL,  -- ms epoch, inicio de la ventana
  count        INTEGER NOT NULL,
  PRIMARY KEY (bucket, subject, window_start)
) WITHOUT ROWID;
```

`WITHOUT ROWID` deja una sola fila escrita por hit (sin índice secundario del PK). No se crea un índice por `window_start` (sumaría una escritura por hit): la limpieza usa `DELETE ... WHERE window_start < ?` con scan, aceptable porque la tabla se mantiene en el orden de miles de filas con retención de 24 h.

### D2. Dónde se aplica: costo acotado y degradación elegida

- **Solo se escribe en D1 para**: login/callback, mutaciones, `calendario/sync`, y **fallos** de Bearer en admin. Las lecturas autenticadas y las públicas no escriben (D4).
- **Orden en `withApi`**: primero origen/`Content-Type` (barato, sin I/O), después el límite por IP, después el límite por usuario (solo si hay sesión). Si el límite por IP ya bloqueó, no se evalúa el de usuario (una escritura menos).
- **Bloqueados**: el `count` sigue subiendo (un UPSERT por intento). Para acotar el costo bajo ataque, pasado `limit * 5` en la misma ventana se responde 429 **sin escribir**: hace falta leer el contador, así que el flujo es `UPSERT` hasta `5x` y desde ahí un `SELECT` (una lectura no cuesta filas escritas).
  - *Alternativa descartada*: leer siempre primero y escribir después: dobla la latencia en el camino feliz.
- **Fail-open**: si D1 falla al contar, se deja pasar y se loguea `error` (`rate_limit_unavailable`). Un incidente de D1 no debe tumbar la app entera por el limitador. **Excepción**: login de admin (D5) también es fail-open; el riesgo se acepta porque `ADMIN_SECRET` debe ser largo y aleatorio.
- **Presupuesto en el plan Free (100.000 filas/día)**: con los límites del §5.3, un usuario muy activo genera del orden de 100 hits/día. 500 usuarios activos al día serían ~50.000 filas escritas: dentro del límite, con margen para el sync (`sync_runs`, `calendar_syncs`). Si el volumen real se acerca al 50% del límite, se migra el backend (§12). La métrica del §8 incluye las filas escritas por el limitador.

### D3. Dominio propio y WAF son complementarios, no requisito

Mientras la app viva en `fisture.pages.dev`, la protección es la del código (D1). Si se adopta un dominio propio en Cloudflare, se agrega una regla WAF (plan Free: 1 regla, por IP) sobre `/api/auth/` como primera barrera, sin cambiar el código. Es una mejora operativa, no parte de la implementación.

### D4. Lecturas públicas: límite en memoria + caché

`GET /api/equipos/buscar` usa un limitador en memoria del isolate (`memoryLimiter`): 60 requests por minuto por IP. Es aproximado (cada isolate cuenta por separado) pero frena un barrido simple sin gastar escrituras de D1. Además se endurece la consulta: `q` de máx. 50 caracteres y `Cache-Control: public, max-age=60` para que Cloudflare absorba repeticiones. Si en producción se ve abuso real (métrica del §8), se pasa a D1 con una línea de configuración.

### D5. Fallos de Bearer en admin

`/api/admin/*` limita solo los **fallos**: 5 intentos fallidos por IP cada 15 minutos; al sexto, 429 aunque el Bearer sea correcto durante esa ventana (así un atacante no puede confirmar el secreto una vez agotado el límite). Es una decisión abierta: ver R5 en el §12. Las requests con Bearer válido no cuentan ni escriben. El workflow `sync-cron.yml` envía el Bearer correcto desde IPs compartidas de GitHub: un secreto mal configurado (fallos repetidos) bloquearía también el cron durante 15 minutos; se loguea claramente y es recuperable.

### D6. Verificación de origen generalizada en `withApi` (reutiliza `esMismoOrigen`)

**Qué.** La verificación vive **una sola vez** en `src/lib/auth/guards.ts` como `esMismoOrigen(request, env): boolean`, que es la función que ya prevé el TDD 14. Este TDD la **generaliza** (no la duplica) y `withApi` la aplica automáticamente a `POST/PUT/PATCH/DELETE`. El handler de borrado de cuenta deja de llamarla a mano.

Reglas de `esMismoOrigen`:

1. `Sec-Fetch-Site`: `same-origin` o `none` (acción directa del usuario) → permitir. `cross-site` o `same-site` → rechazar.
2. Sin `Sec-Fetch-Site` (navegadores viejos o clientes no navegador): si hay `Origin`, debe ser igual a `new URL(PUBLIC_APP_URL).origin` o al origen de la propia request; si no hay `Origin` ni `Sec-Fetch-Site` → rechazar **cuando la request lleva cookie de sesión**.
3. Solo se evalúa si la request trae la cookie `session`. Las requests con `Authorization: Bearer` y sin cookie (cron, `admin/*`) quedan exentas: CSRF aplica a credenciales ambientales (cookies), no a Bearer.
4. Orígenes extra (previews futuros) vía `ALLOWED_ORIGINS` opcional (lista separada por comas); por defecto, vacío.

`Content-Type`: en `POST/PUT/PATCH` con cuerpo, se exige `application/json` (con o sin `; charset=`). Si no, 415. Excepción por ruta declarada (`contentType: "any"`) para los endpoints que reciban otro formato (ninguno hoy; **a confirmar** revisando `fix/sync-cron-content-type` al implementar, porque esa rama tocó el `Content-Type` del cron).

**Por qué `withApi` y no el middleware.** El middleware corre para páginas y APIs y no conoce la configuración por ruta. `withApi` ya envuelve todo handler de API, ya tiene el logger y el requestId, y es donde se pueden declarar excepciones por ruta.

**Alternativas descartadas.** Token CSRF por formulario (más piezas de estado en un API JSON puro); pasar `SameSite=Strict` (rompe el retorno desde OAuth, que usa redirección cross-site y depende de `lax`); hacerlo en el middleware.

**API de `withApi`:**

```ts
withApi(handler, {
  rateLimit: [{ bucket: "calendar_sync", scope: "user", limit: 10, windowSec: 60 }],
  origin: "session",   // por defecto en métodos que mutan; "none" para admin/Bearer
})
```

Valores por defecto: métodos que mutan → `origin: "session"` y límite genérico del §5.3. Una ruta sin `rateLimit` explícito que muta cae en el límite genérico (**falla segura**: un endpoint nuevo nunca queda sin límite). Un test de descubrimiento (§7) lista los handlers de `pages/api/**` y falla si alguno se exporta sin `withApi`.

### D7. Identidad del sujeto sin datos personales

- Por usuario: `user.id` (ya es el que se loguea hoy).
- Por IP: `cf-connecting-ip`, nunca se guarda en claro: `subject = base64url(HMAC-SHA256(RATE_LIMIT_SALT, ip)).slice(0, 22)`. Así la tabla no contiene IPs, y no se puede revertir sin el salt. El salt es un secret nuevo; si falta, se usa `ADMIN_SECRET` como material y se loguea una advertencia en el arranque (a decidir en la revisión; ver R6 en el §12).
- Los logs **no** incluyen IP ni el hash completo: solo `bucket`, `scope` (`ip` | `user`), `limit`, `retryAfter` y `userId` cuando existe (política vigente).
- Sin `cf-connecting-ip` (local/tests) el scope IP se omite y se loguea `debug`.

## 5. Diseño

### 5.1 Módulos

```
src/lib/rate-limit/
├── limiter.ts      # hit(): UPSERT atómico en D1 + cálculo de ventana y Retry-After
├── memory.ts       # limitador en memoria del isolate (D4)
├── policies.ts     # tabla de políticas (§5.3), una sola fuente de verdad
├── subject.ts      # hash de IP con HMAC, id de usuario
└── cleanup.ts      # borra ventanas viejas (lo invoca el sync diario)
src/lib/auth/guards.ts   # esMismoOrigen (+ contentTypeValido), puro y testeable
src/lib/observability/with-api.ts   # orquesta origen -> límite IP -> límite usuario -> handler
```

`limiter.ts` recibe `now` por parámetro (por defecto `Date.now()`), así el test fija el reloj con `relojFijo` y avanza el tiempo con `vi.setSystemTime`.

### 5.2 Garantías

- **Exactitud**: el conteo es exacto y global (una sentencia atómica en D1). Se admite el doble de límite en el borde entre ventanas.
- **Disponibilidad**: fail-open ante falla de D1.
- **Latencia**: una ida a D1 por request limitada (en rutas de mutación que ya consultan D1, es ~1 query más).

### 5.3 Políticas (valores y justificación)

| Bucket | Ruta | Sujeto | Límite | Ventana | Justificación |
| --- | --- | --- | --- | --- | --- |
| `login` | `GET /api/auth/login/*` | IP | 10 | 10 min | Un usuario real inicia login 1-2 veces; deja margen para reintentos y NAT compartido (un hogar o una oficina) |
| `oauth_callback` | `GET /api/auth/callback/*` | IP | 20 | 10 min | Cada login legítimo hace 1 callback; permite el doble que el inicio por redirecciones fallidas |
| `calendar_sync` | `POST /api/calendario/sync` | usuario | 10 | 1 min | "Agregar todos" es 1 request con `matchIds`; el usuario humano difícilmente supera 10 clics por minuto |
| `calendar_sync_hour` | ídem | usuario | 60 | 1 h | Freno de volumen sostenido contra la cuota de Google/Microsoft |
| `calendar_sync_ip` | ídem | IP | 30 | 1 min | Frena varias cuentas desde una misma IP sin castigar NAT pequeños |
| `calendar_delete` | `DELETE /api/calendario/sync` | usuario | 30 | 1 min | Quitar partidos individualmente es más frecuente que agregar en lote |
| `mutation` | resto de `POST/PUT/PATCH/DELETE` (`equipos/*`, `preferencias`, `auth/logout`) | usuario | 60 | 1 min | Seguir/dejar de seguir equipos con clics rápidos cabe holgado |
| `mutation_ip` | ídem | IP | 120 | 1 min | Tope generoso por IP para cubrir NAT |
| `admin_fail` | `/api/admin/*` | IP | 5 fallos | 15 min | Fuerza bruta de `ADMIN_SECRET`; un humano que se equivoca no pasa de 2-3 |
| `search_public` | `GET /api/equipos/buscar` | IP (memoria) | 60 | 1 min | Autocompletado con debounce: unas 10-20 requests por búsqueda |

Más un tope de tamaño: `matchIds` con máximo **50** elementos (400 si se supera). Se justifica con el mayor lote real de la UI de "agregar todos" (a verificar contra la UI al implementar, S4).

### 5.4 Respuesta 429

```
HTTP/1.1 429 Too Many Requests
Retry-After: 37
Content-Type: application/json
Cache-Control: no-store

{ "error": "rate_limited", "retryAfter": 37, "requestId": "..." }
```

`Retry-After` en segundos enteros (RFC 9110). El front debe mostrar un mensaje con la espera (§9, cambios de UI mínimos). 403 con `{ "error": "forbidden_origin" }` para origen inválido; 415 con `{ "error": "unsupported_media_type" }`.

## 6. Casos a cubrir (con IDs)

**Límite de tasa**

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| RL1 | Hasta `limit` requests en la ventana | Todas pasan; la siguiente da 429 |
| RL2 | 429 trae `Retry-After` correcto | Igual al tiempo restante de la ventana (redondeo hacia arriba, mínimo 1) |
| RL3 | La ventana siguiente | El contador arranca de cero |
| RL4 | Dos usuarios distintos | Contadores independientes |
| RL5 | Dos IP distintas | Contadores independientes |
| RL6 | 20 requests concurrentes con límite 10 | Exactamente 10 pasan (atomicidad) |
| RL7 | Pasado `limit x 5` | 429 sin escribir en D1 (comprobado contando filas y `count`) |
| RL8 | Falla de D1 al contar | La request pasa y se loguea `rate_limit_unavailable` |
| RL9 | Request sin sesión en endpoint por usuario | Aplica solo el límite por IP |
| RL10 | Sin `cf-connecting-ip` | Se omite el scope IP, sin error |
| RL11 | `POST /api/calendario/sync` con 51 `matchIds` | 400, sin consumir cuota de calendario |
| RL12 | `calendar_sync` por usuario y por hora | Ambos límites se aplican; vence el más restrictivo |
| RL13 | Bearer inválido 5 veces | A la sexta, 429 (con Bearer correcto también durante la ventana) |
| RL14 | Bearer válido repetido | No cuenta, no escribe, no se bloquea |
| RL15 | `buscar` 61 veces en un minuto desde una IP | La 61 da 429; la memoria se reinicia por isolate nuevo (documentado, no testeado) |
| RL16 | Handler de `pages/api/**` sin `withApi` | El test de descubrimiento falla |
| RL17 | `RATE_LIMIT_DISABLED=true` | Nada se limita ni escribe; el origen se sigue verificando |

**Origen y `Content-Type`**

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| OR1 | `POST` con cookie, `Sec-Fetch-Site: same-origin` | Pasa |
| OR2 | `POST` con cookie, `Sec-Fetch-Site: cross-site` | 403 `forbidden_origin` |
| OR3 | `POST` con cookie, `Sec-Fetch-Site: same-site` (otro subdominio) | 403 |
| OR4 | Sin `Sec-Fetch-Site`, `Origin` = `PUBLIC_APP_URL` | Pasa |
| OR5 | Sin `Sec-Fetch-Site`, `Origin` ajeno | 403 |
| OR6 | Con cookie, sin `Origin` ni `Sec-Fetch-Site` | 403 |
| OR7 | Bearer sin cookie y sin `Origin` (cron) | Pasa |
| OR8 | `GET`/`HEAD`/`OPTIONS` con origen ajeno | Pasa (no mutan) |
| OR9 | `DELETE` con cookie desde `cross-site` | 403 |
| OR10 | `POST` JSON con `Content-Type: text/plain` | 415 |
| OR11 | `POST` con `application/json; charset=utf-8` | Pasa |
| OR12 | `POST` sin cuerpo y sin `Content-Type` (p. ej. logout) | Pasa |
| OR13 | `Origin` en `ALLOWED_ORIGINS` | Pasa |
| OR14 | El borrado de cuenta (TDD 14) usa la misma función | Una sola implementación de `esMismoOrigen` en el repo (test que lo comprueba por importación) |
| OR15 | El rechazo por origen se registra | `warn` con `route`, sin cabeceras `Origin` completas ni cookies |

**Observabilidad**

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| OB1 | 429 | Log `warn` `rate_limited` con `bucket`, `scope`, `limit`; sin IP ni hash |
| OB2 | `GET /api/admin/status` | Incluye `rateLimit.last24h`: por bucket, `blocked` (hits sobre el límite) y `subjects` distintos |
| OB3 | `GET /api/health` (público) | No expone nada de rate limiting |

## 7. Estrategia de tests (test primero)

Ciclo por paso del §10: **rojo** (el test falla por la razón correcta), **verde** (lo mínimo para pasar), **refactor** (sin cambiar tests).

- **Unidades puras** (`tests/unit/`): `esMismoOrigen`, `contentTypeValido`, cálculo de ventana y `Retry-After`, `subject.ts`. Sin D1. Tablas de casos para OR1-OR13.
- **Integración con D1 efímera** (`tests/integration/`, `useTestDb`): `hit()` real contra la D1 de Miniflare. La migración se aplica como el resto de las de `drizzle/migrations`; `useTestDb` vacía `rate_limits` en cada test (descubre las tablas sola). RL6 usa `Promise.all` de 20 llamadas: valida la atomicidad del UPSERT, que es el corazón del diseño.
- **Reloj fijo** (`tests/helpers/clock.ts`): `relojFijo()` fija `AHORA` (2026-10-21T15:00:00Z). Para pasar de ventana: `vi.setSystemTime(new Date(AHORA.getTime() + 61_000))`. Como el helper solo simula `Date`, los timers reales de Miniflare siguen funcionando. Para el borde de ventana se usa un `now` que cae justo en el múltiplo del `windowMs` (RL3). `limiter.ts` recibe `now` inyectable, así que casi no hace falta mover el reloj global.
- **Handlers con `apiCtx`** (`tests/helpers/ctx.ts`): se invoca el handler envuelto con `withApi`, pasando `headers` (`cf-connecting-ip`, `sec-fetch-site`, `origin`, `cookie`) y `env` con `DB` real y `PUBLIC_APP_URL`. `silenciarConsola(vi)` evita ruido; para OB1/OR15 se espía `console` y se afirma que el JSON logueado no contiene la IP.
- **Memoria**: `memory.ts` con reloj fijo y un `Map` reiniciable entre tests.
- **Descubrimiento (RL16)**: extiende el guard de `npm test` para que cada archivo de `pages/api/**` use `withApi` y declare una política o caiga explícitamente en el genérico.
- **E2E (Playwright)**: un caso de humo, no de carga: 429 simulado devuelve un mensaje legible en la UI de "agregar al calendario". Sin test de volumen en CI.
- **Cobertura**: los módulos nuevos entran en los umbrales de `npm run test:coverage`.
- **Spikes** (S1-S4, §10 paso 0): se ejecutan contra un despliegue real, **no** son parte del CI.

## 8. Observabilidad y métricas

- **Log** `warn rate_limited` por cada 429 (campos del §4/D7). Se loguea el primer bloqueo de cada ventana en `warn` y el resto en `debug`, para no inundar el log durante un ataque.
- **`/api/admin/status`** suma `rateLimit`: consulta `SELECT bucket, SUM(count > limit) ...` sobre las filas de las últimas 24 h (la retención de `cleanup.ts` es de 24 h). No requiere una tabla de métricas aparte ni escrituras extra: los bloqueos se derivan del propio contador. Para conocer el `limit` por bucket se usa `policies.ts`.
- **Costo**: el mismo endpoint informa filas de `rate_limits` y una estimación de escrituras del día (para vigilar el presupuesto de D2).
- **Alerta manual**: si `blocked / total` de un bucket supera el 5% durante un día, la política está mal calibrada o hay abuso; se decide con los logs.

## 9. UI

Cambio mínimo: el cliente que llama a `/api/calendario/sync` interpreta el 429 y muestra "Demasiados intentos. Probá de nuevo en N segundos" usando `retryAfter`. Los demás clientes reciben el mensaje genérico de error de red ya existente. Sin nuevos componentes.

## 10. Plan de implementación

0. **Spikes de verificación** (sin código de producción; se documenta el resultado en las notas):
   - **S1**: ¿el binding `ratelimit` funciona en Pages Functions? Prueba: un proyecto Pages de descarte con `[[ratelimits]]` en `wrangler.toml`, `wrangler pages deploy` y llamada a `env.RL.limit({ key })`. Si funciona y la ventana de 10/60 s alcanza en algún caso, se evalúa como backend alternativo en D1 (§12). **A verificar.**
   - **S2**: ¿se puede enlazar un Durable Object desde Pages con la configuración actual de `deploy.yml`? Solo importa si D1 resulta insuficiente (§12). **A verificar.**
   - **S3**: plan real de la cuenta de Cloudflare (Free o Paid) para dimensionar los límites de D1 (100.000 filas/día) y KV. **Requiere acceso del usuario al dashboard.**
   - **S4**: tamaño máximo real de `matchIds` que envía la UI y comportamiento de `cf-connecting-ip` en `*.pages.dev` (esperado: presente; confirmar con un log temporal en un despliegue de prueba).
1. **Tests de unidades puras** (rojo): `esMismoOrigen`, `contentTypeValido`, ventana y `Retry-After`, `subject`. Verde: `guards.ts`, `limiter` (parte pura), `subject.ts`. Se mueve/crea `esMismoOrigen` aquí si el TDD 14 todavía no está mergeado (el que llegue primero a `development` la define; el otro la importa).
2. **Migración `rate_limits`** y test de integración de `hit()` con la D1 efímera (RL1-RL7, RL12). Verde: `limiter.ts`.
3. **`withApi`**: opciones `rateLimit` y `origin`, respuestas 403/415/429, logs (RL8-RL10, RL17, OR1-OR15, OB1). Se aplica el comportamiento por defecto a todos los handlers que mutan. Refactor: el borrado de cuenta (TDD 14) deja su verificación manual y usa la de `withApi`.
4. **Políticas por ruta** (`policies.ts`): login/callback, `calendario/sync` (incluido el tope de 50 `matchIds`, RL11), mutaciones genéricas.
5. **Admin**: límite de fallos de Bearer (RL13, RL14) sin tocar `isAdminAuthorized` salvo para exponer el resultado.
6. **Lecturas públicas**: `memory.ts` y `buscar` (RL15), con el tope de `q` y `Cache-Control`.
7. **Limpieza y métricas**: `cleanup.ts` enganchado al sync diario (`runSync`), sección `rateLimit` en `/api/admin/status` (OB2, OB3).
8. **UI**: mensaje de 429 en el cliente de calendario + caso E2E de humo.
9. **Test de descubrimiento** (RL16) y actualización de `CLAUDE.md` (sección Observabilidad: "todo handler declara su política") y `docs/07-backend-api.md`.

## 11. Despliegue y rollback

**Despliegue**

- Secret nuevo: `RATE_LIMIT_SALT` (32 bytes aleatorios; `wrangler pages secret put RATE_LIMIT_SALT`). Documentarlo en `docs/08-deploy-infraestructura.md`. Si no está, se usa `ADMIN_SECRET` como material (decisión abierta, ver R6 en el §12).
- Variables nuevas (opcionales, en `[vars]` o secrets): `RATE_LIMIT_DISABLED` (por defecto ausente), `ALLOWED_ORIGINS` (por defecto vacío).
- `wrangler.toml`: **sin bindings nuevos** (usa `DB` y `KV` existentes). `src/env.d.ts` suma las variables opcionales.
- Migración D1 `rate_limits`: aditiva. `deploy.yml` ya aplica las migraciones antes de desplegar. Una tabla vacía no afecta al código anterior.
- Primer despliegue en **modo observación** (opcional, recomendado): `RATE_LIMIT_MODE=observe` cuenta y loguea `rate_limited` pero no devuelve 429, durante un par de días. Esto da datos reales para calibrar el §5.3 antes de bloquear. (Pendiente de aprobación del usuario; si se aprueba, se agrega RL18: en `observe` pasa y loguea.)

**Rollback / apagado rápido (si bloquea usuarios legítimos)**

1. Más rápido (minutos, sin deploy de código): poner `RATE_LIMIT_DISABLED=true` en las variables de Pages y re-desplegar con `wrangler pages deploy` (las variables de Pages se leen en el siguiente despliegue; **a verificar** si el dashboard permite editarlas sin redeploy: de ser así es inmediato).
2. Ajuste fino: subir el límite del bucket afectado en `policies.ts` y desplegar por el flujo normal (hotfix `fix/*` desde `main`).
3. Revertir el PR: la tabla `rate_limits` queda sin uso; no hace falta migración inversa (`DROP TABLE` opcional en una migración posterior).
4. Un IP concreto bloqueado por error: esperar el fin de la ventana (máx. 15 min) o borrar su fila con `wrangler d1 execute` (el `subject` es un hash, así que se calcula con el salt; se documenta el comando en el runbook).

La verificación de origen **no** se apaga con `RATE_LIMIT_DISABLED`: es un control de seguridad distinto. Si un cliente legítimo se bloquea por origen, se corrige con `ALLOWED_ORIGINS`.

## 12. Riesgos y decisiones abiertas

| # | Riesgo / decisión | Mitigación |
| --- | --- | --- |
| R1 | **NAT compartido** (colegio, oficina, operadora móvil con CGNAT): muchos usuarios legítimos con la misma IP | Los límites por IP son de 3 a 10 veces el uso humano normal; el límite estricto es por usuario, no por IP. Modo `observe` antes de bloquear |
| R2 | **Presupuesto de escrituras de D1** (100.000/día en Free) | D2: escritura solo donde importa, tope `5x` sin escribir, métrica del §8; si pasa del 50% se pasa a DO o binding (§3, S1/S2) |
| R3 | **Falsos positivos en el cron** de GitHub Actions por D5 | Un fallo de Bearer lo causa el secreto mal configurado, no el uso normal; se loguea claro y se recupera en 15 min |
| R4 | `cf-connecting-ip` ausente o spoofeable | En Cloudflare lo setea el borde y no es falsificable por el cliente; verificar en S4. Sin la cabecera se omite el scope IP |
| R5 | D5 bloquea incluso un Bearer correcto durante la ventana | Evita que un atacante confirme el secreto, pero deja al operador sin acceso hasta 15 min; alternativa: dejar pasar el Bearer correcto. **Decisión abierta para la revisión** |
| R6 | `RATE_LIMIT_SALT` como secret nuevo | Fallback a `ADMIN_SECRET`: acopla dos secretos. **Decisión abierta**: ¿exigir el secret nuevo antes de desplegar? |
| R7 | Ventana fija permite 2x en el borde | Aceptado; si importa en `calendar_sync`, ya hay un límite por hora que lo acota |
| R8 | `Sec-Fetch-Site` ausente en clientes viejos o proxys que lo quitan | Cae a `Origin`; si tampoco hay y hay cookie, se rechaza (falla segura) |
| R9 | Test de descubrimiento y el guard de `npm test` pueden asumir que todas las migraciones tienen esquema en Drizzle | La tabla se declara también en `drizzle/schema.ts` para el tipado (sin `WITHOUT ROWID`) y se verifica que `db:generate` no proponga un cambio espurio |
| R10 | Conflicto de orden con el TDD 14 (`esMismoOrigen`) | Quien se implemente primero la define en `guards.ts`; el otro solo importa (§10, paso 1) |

**Después de esta iteración** (fuera de alcance): Turnstile en el login si hay registro masivo; migrar a Durable Objects o al binding `ratelimit` si S1/S2 lo permiten y D1 se queda corto; regla WAF si se adopta dominio propio (D3); límites diferenciados por plan de usuario.

## 13. Notas de implementación (desvíos respecto del diseño original)

### 13.1 Spikes del §10 paso 0: qué se confirmó y con qué fuente

Consultas hechas el 2026-11-05 en la documentación oficial de Cloudflare (`developers.cloudflare.com`). No se desplegó nada ni se tocó la cuenta: lo que exige el dashboard o un despliegue de prueba queda como pendiente del dueño.

| Spike | Resultado | Fuente |
| --- | --- | --- |
| **S1** ¿`ratelimit` en Pages Functions? | **No está documentado como soportado**, así que se descarta. La página de configuración de Wrangler para Pages lista los bindings que acepta (`d1_databases`, `durable_objects`, `hyperdrive`, `kv_namespaces`, `queues.producers`, `r2_buckets`, `vectorize`, `services`, `analytics_engine_datasets`, `ai`) y `ratelimit`/`[[ratelimits]]` no figura; la página de bindings de Pages dice "Pages Functions only support a subset of all bindings, which are listed on this page". La página del binding (`[[ratelimits]]` con `name`, `namespace_id`, `[ratelimits.simple] limit/period`, Wrangler >= 4.36.0) habla solo de Workers y no menciona Pages ni restringe por plan. Aunque funcionara, `period` solo admite 10 o 60 s (no sirve para "10 logins cada 10 min" ni "5 fallos de admin cada 15 min") y el conteo es aproximado y por ubicación. No se probó con un despliegue real (no se tocó Cloudflare). | `pages/functions/wrangler-configuration/`, `pages/functions/bindings/`, `workers/runtime-apis/bindings/rate-limit/` (actualizada 2026-10-21) |
| **S2** ¿Durable Objects desde Pages? | Sí, pero la clase tiene que vivir en un **Worker separado** ("You cannot create and deploy a Durable Object within a Pages project") y el binding en el `wrangler.toml` de Pages exige `script_name`. Sigue siendo la ruta de escalado si D1 no alcanza (§12); no hizo falta. | `pages/functions/wrangler-configuration/` (sección Durable Objects), `pages/functions/bindings/` |
| **S3** Plan real de la cuenta | **Pendiente del dueño** (dashboard). El diseño asume Workers Free y D1 Free (100.000 filas escritas por día); `docs/24` mide hoy menos de 300 escrituras por día. | n/a |
| **S4** Tamaño de `matchIds` y `cf-connecting-ip` | El mayor lote real de la UI es 25 (`LOTE_MAXIMO` en `hoy.astro` y `LOTE_MANUAL` en `calendario.astro`), así que el tope de 50 queda holgado (verificado en el código). `cf-connecting-ip` en `*.pages.dev`/`fisture.com` **no se pudo comprobar** sin un despliegue: si la cabecera falta, el scope IP se omite y se loguea `rate_limit_ip_omitida` en `debug` (RL10), es decir que el límite por usuario sigue funcionando. Para confirmarlo, ver el paso manual en "Despliegue y riesgos" del PR. | código del repo |
| O1 WAF en `pages.dev` | No verificado (la documentación del WAF no lo menciona). Como la app se sirve en `fisture.com` (dominio propio), la regla de D3 es viable y queda como mejora opcional manual. | `waf/rate-limiting-rules/` |
| Cómo apagar rápido (§11) | `wrangler.toml` es la fuente de verdad de los campos que define y no se pueden editar en el dashboard (`pages/functions/wrangler-configuration/`). `RATE_LIMIT_DISABLED` **no** está en `[vars]`, así que se define como **secret de Pages** (`wrangler pages secret put`), que se lee en cada request sin redeploy (como ya describe `docs/23` §5). | `pages/functions/wrangler-configuration/`, `docs/23` §5 |

Conclusión: el binding de Workers no es viable en Pages, por lo que se mantuvo la opción que el TDD recomendaba (O4, contadores en D1 detrás de la interfaz `hit()/peek()`). Cambiar el backend más adelante solo toca `lib/rate-limit/limiter.ts`.

### 13.2 Qué se implementó

- `drizzle/migrations/0013_rate_limits.sql` (tabla `WITHOUT ROWID`), `src/lib/rate-limit/{policies,limiter,subject,memory,cleanup,metricas}.ts`.
- `esMismoOrigen` generalizado y `contentTypeValido` en `lib/auth/guards.ts`; `withApi` aplica origen, `Content-Type` y límites (opciones `rateLimit`, `origin`, `contentType`). Las rutas `cuenta`, `identidades` y `vincular` dejaron su chequeo manual.
- Políticas declaradas en `login`, `callback`, `calendario/sync` (POST y DELETE) y `equipos/buscar`; el resto de las mutaciones cae en el límite genérico. `admin/*` usa `verificarAdmin` (D5).
- Limpieza de ventanas de más de 24 h dentro de `runSync`; `GET /api/admin/status` suma `rateLimit`.
- UI: `mensajeDeLimite` en `lib/sync-ui.ts`, usado por `SincronizarPartido` y `SincronizarTodo`; caso E2E de humo.
- Variables nuevas: `RATE_LIMIT_SALT` (secret), `RATE_LIMIT_DISABLED`, `RATE_LIMIT_MODE` y `ALLOWED_ORIGINS` (opcionales). Sin bindings nuevos.

### 13.3 Desvíos respecto del diseño

1. **El tope `limit x 5` se resuelve dentro del mismo UPSERT** (`... DO UPDATE SET count = count + 1 WHERE count < limit*5 RETURNING count`), sin el `SELECT` posterior que describía D2. Pasado el tope, la sentencia no actualiza ni devuelve fila: una sola ida a D1, sin escritura (RL7 lo comprueba contando filas y `count`).
2. **`esMismoOrigen` no acepta "el origen de la propia request"** (regla 2 del TDD). `docs/14` ya fijó, y tiene test, que un `PUBLIC_APP_URL` inválido rechaza cualquier `Origin`; aceptar el origen de la request lo contradecía. Los accesos por un alias de Pages (`*.fisture.pages.dev`) funcionan igual porque el navegador manda `Sec-Fetch-Site: same-origin`; el caso de navegadores sin esa cabecera se cubre con `ALLOWED_ORIGINS`. Además, con `Sec-Fetch-Site` `cross-site`/`same-site` se acepta solo si el `Origin` está permitido (útil para `www.`).
3. **Cuerpos de error unificados.** Los rechazos de `withApi` son `{ "error": "forbidden_origin" }` (403) y `{ "error": "unsupported_media_type" }` (415), como pedía el §5.4. `cuenta`, `identidades` y `vincular` devolvían antes textos en español; los status no cambian y la UI no depende del texto.
4. **Sin declaración en `drizzle/schema.ts`** (R9). La tabla se usa con SQL directo sobre `D1Database` (`hit()` es una sentencia con `RETURNING`), así que no hacía falta el tipado de Drizzle y se evita un conflicto de merge con los PRs paralelos que también tocan el esquema. El test de esquema de Drizzle sigue verde.
5. **D5 vive en `verificarAdmin` (`lib/observability/admin-auth.ts`), no en `withApi`**, porque necesita ver el resultado de la autorización: `peek` del contador de fallos (429 si ya está en el límite, incluso con Bearer correcto: R5 se resolvió como estaba propuesto) y `hit` solo ante un Bearer inválido. Las rutas `admin/*` se declaran con `origin: "none"` y `rateLimit: []`; `admin/sync` además con `contentType: "any"` para no cambiar el contrato del cron.
6. **`RATE_LIMIT_MODE=observe` (RL18) quedó implementado**: cuenta y loguea `rate_limited` con `observe: true`, pero no devuelve 429. Es el modo recomendado para el primer despliegue. También cubre `admin_fail`.
7. **R6 (salt)**: se mantuvo el fallback a `ADMIN_SECRET`; sin ninguno de los dos el scope IP se omite (el de usuario sigue). Se recomienda cargar `RATE_LIMIT_SALT`.
8. **Métricas (§8)**: `rateLimit.ultimas24h` informa por bucket `hits`, `blocked` (acotado por el tope `limit x 5`), `subjects` y `limit`, más `filas` totales de la tabla. No hay una "estimación de escrituras del día" aparte: `hits` equivale a las escrituras (salvo las que pegaron el tope). `search_public` usa memoria y no aparece. Las métricas nunca exponen sujetos.
9. **`buscar`**: la respuesta con sesión lleva `Cache-Control: private, max-age=60` (y `public` solo la anónima) porque incluye `isFollowing`; el TDD pedía `public` sin distinguir.
10. **Tope de `matchIds`**: 50, respondiendo `400 { "error": "too_many_matchIds", "max": 50 }`.
11. **Test de descubrimiento (RL16)** es un test unitario (`tests/unit/rate-limit/descubrimiento.test.ts`) que lee `pages/api/**`, no una extensión de `scripts/check-test-discovery.mjs` (ese guard verifica que los tests se descubran, no los handlers). Verifica que cada método exportado use `withApi`, que `login` y `callback` declaren política y que `esMismoOrigen` se defina una sola vez (OR14).
12. **E2E**: el caso de humo reutiliza el escenario de sesión `calendar` del servidor E2E existente.

### 13.4 Fuera de alcance / conocido

- `GET /api/auth/logout` sigue siendo un `GET` que cambia estado (cierra la sesión): no pasa por la verificación de origen y un sitio ajeno podría cerrar la sesión (molestia, no robo de datos). Pasarlo a `POST` cambia los enlaces de la UI; queda para otro PR.
- El límite de `login`/`callback` usa un hash de IP: usuarios detrás de un mismo NAT comparten contador (R1). Los valores del §5.3 se mantienen; `RATE_LIMIT_MODE=observe` permite calibrarlos antes de bloquear.
- Pendiente del dueño: S3, confirmar `cf-connecting-ip` y, opcionalmente, la regla del WAF de D3. Los pasos están en la descripción del PR y en `docs/23` §6.
