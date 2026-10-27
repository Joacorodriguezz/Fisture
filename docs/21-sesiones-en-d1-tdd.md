# TDD: Sesiones en D1 (en lugar de KV)

> Technical Design Document. Estado: **propuesto, pendiente de revisión**. Fecha: 2026-10-26. Rama de implementación: `feat/sesiones-en-d1`, desde `development`.
>
> Este documento registra **qué problema hay hoy, qué decidimos y por qué**. El código y los tests se escriben después de que se apruebe, siguiendo el orden del §7. No es urgente: el incidente del 2026-10-26 se resuelve con `docs/20-login-sin-kv-tdd.md`. Este cambio saca el último uso de KV que crece con los usuarios.

## 1. Contexto y problema

Las sesiones viven en KV (`src/lib/auth/session.ts`): `createSession` hace `KV.put("session:<id>", userId)` con TTL de 30 días, `getSession` hace `KV.get` y `deleteSession` hace `KV.delete`. La cookie `session` lleva el `<id>` (32 bytes aleatorios, base64url).

### 1.1 Qué cuesta eso hoy

| # | Problema | Evidencia |
| --- | --- | --- |
| P1 | **Tope de 1.000 escrituras por día** en el plan Free (y 1.000 borrados). Cada login completado gasta una; el 2026-10-26 el login quedó caído por agotar esa cuota (ver `docs/20`) | Log de producción: `KV put() limit exceeded for the day` |
| P2 | **Dos viajes por request autenticada.** El middleware lee la sesión en KV y después pide el usuario a D1 (`src/middleware.ts`) | Lectura del código |
| P3 | **Consistencia eventual.** KV puede tardar hasta un minuto en propagar un cambio a otros centros de datos. Un `logout` o un borrado de cuenta puede no aplicarse al instante en todos lados, y una sesión recién creada puede no verse de inmediato desde otra ubicación | Documentación de KV (a verificar con el spike del §7, paso 0) |
| P4 | **No se pueden listar ni revocar las sesiones de un usuario.** KV no permite buscar por usuario, así que al borrar la cuenta quedan claves huérfanas que vencen solas a los 30 días (`docs/14` D7), y no existe "cerrar sesión en todos los dispositivos" | `docs/14` §3 |
| P5 | **Un fallo de KV después de borrar en D1** obligó a agregar un `try/catch` best-effort en `api/cuenta.ts` (revisión del PR #26) | `docs/14` §9 |

### 1.2 Uso de recursos hoy (medido)

D1 en el plan Free: 5 millones de filas leídas por día y 100 mil escritas por día, con enforcement desde 2026-09-01. Uso real del 21 al 26 de octubre: **90 mil a 226 mil filas leídas por día** (2 % a 5 %) y **menos de 300 escritas por día** salvo el primer día de carga (20 mil). Hay mucho margen para absorber las sesiones.

## 2. Objetivos y no objetivos

**Objetivos**

1. Las sesiones se guardan en una tabla de D1. **Ninguna operación de sesión toca KV.**
2. El middleware resuelve cookie → usuario con **una sola consulta** a D1.
3. Borrar la cuenta borra sus sesiones **en la misma operación atómica** (clave foránea con cascada). Se elimina el paso de KV y el `try/catch` de `api/cuenta.ts`.
4. Una sesión expirada nunca autentica, aunque su fila todavía exista; las filas vencidas se limpian solas.
5. El `session id` **no se guarda en claro**: la base solo tiene su hash, así que una filtración de la tabla no da sesiones válidas.
6. Quedan disponibles `deleteUserSessions` (revocar todas las sesiones de un usuario) y la lista de sesiones por usuario, aunque la UI no los use todavía.
7. Cubierto por tests, incluido uno de regresión que verifica que login y logout hacen 0 operaciones de KV.

**No objetivos**

- Cambiar la cookie (nombre, atributos, duración) ni el flujo de OAuth.
- Renovar la sesión en cada request (ver D4).
- Pantalla de "mis sesiones" o "cerrar en todos los dispositivos" (queda habilitada, no construida).
- Sacar el binding `KV` del proyecto: se sigue usando para la caché de partidos (`MATCHES_CACHE_KEY`) y el chequeo de salud.
- Migrar a sesiones sin estado (cookie firmada); se descarta en D5.

## 3. Decisiones

**D1. Tabla `sessions` en D1.**

```
sessions
  id          TEXT PRIMARY KEY      -- SHA-256 en hexadecimal del token de la cookie
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE
  created_at  INTEGER NOT NULL      -- segundos Unix
  expires_at  INTEGER NOT NULL      -- segundos Unix
INDEX sessions_user_id_idx ON sessions(user_id)
INDEX sessions_expires_at_idx ON sessions(expires_at)
```

El token de la cookie sigue siendo el mismo (32 bytes aleatorios, 43 caracteres base64url). La base guarda `sha256(token)`. Como el token ya es aleatorio de alta entropía, SHA-256 simple alcanza (no hace falta un hash lento ni sal). La búsqueda compara el hash exacto por clave primaria.

**D2. Una consulta para sesión y usuario.**

```sql
SELECT u.* FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.id = ? AND s.expires_at > ?
LIMIT 1
```

Cuesta unas 2 filas leídas por request autenticada y reemplaza una lectura de KV más una consulta a D1. Un hash que no existe, una sesión expirada o un usuario borrado devuelven vacío por el mismo camino, y el middleware borra la cookie como hoy.

**D3. Cascada para el borrado de cuenta.** `ON DELETE CASCADE` limpia las sesiones del usuario junto con `user_teams`, `user_preferences` y `calendar_syncs`, dentro del mismo `DELETE FROM users` que ya hace `deleteAccount`. `api/cuenta.ts` deja de llamar a `deleteSession` y se elimina la rama `session_cleanup_failed` (su razón de ser era KV). Depende de que D1 aplique las claves foráneas, algo que ya se comprueba con el conteo de filas huérfanas (`docs/14` D3, C4).

**D4. Expiración fija de 30 días, sin renovar en cada request.** Es lo que hace hoy KV con su TTL. Renovar en cada request (`last_seen`) escribiría en D1 en todas las requests autenticadas y consumiría la cuota de 100 mil escrituras por día de forma proporcional al tráfico. Si más adelante se quiere renovar, se hace como mucho una vez por día por sesión, en otro TDD.

**D5. Alternativas descartadas.**

| Alternativa | Por qué no |
| --- | --- |
| Seguir en KV y pasar a Workers Paid | Quita el tope pero conserva P2 a P5 y suma costo mensual. Sigue siendo válida si D1 resultara un problema |
| Sesión firmada en la cookie, sin almacenamiento | No hay lecturas ni escrituras, pero **no se puede revocar** del lado del servidor: un `logout` no invalida una cookie robada y un borrado de cuenta no corta sesiones. Peor que lo que hay hoy para una app con acceso al calendario |
| Guardar el token en claro en D1 | Una filtración de la tabla regalaría sesiones válidas. El hash cuesta una línea |
| Tabla de sesiones en una base D1 aparte | Rompe la cascada con `users` y la atomicidad del borrado, y no resuelve nada que importe |
| Durable Object por usuario | Otro runtime, otro binding y costo, para algo que una tabla resuelve |

**D6. Limpieza de sesiones vencidas dentro del sync diario.** `runSync` ejecuta `DELETE FROM sessions WHERE expires_at < ?` con el ahora (con una cota de filas por corrida) y registra la cantidad en el log (`sessions_purged`, sin ids). Evita agregar otro cron. Mientras no corre, las filas vencidas no autentican (D2 filtra por `expires_at`), así que la limpieza es solo higiene.

**D7. Transición: no se migran las sesiones existentes.** Al desplegar, las sesiones que están en KV dejan de valer y cada persona vuelve a iniciar sesión una vez. Es la opción más simple y segura; la alternativa (leer de D1 y, si no hay, de KV y copiar) deja código transitorio durante 30 días y mantiene la dependencia de KV que se quiere sacar. **Decisión abierta para el usuario (§9, Q1):** con pocos usuarios hoy y el login caído hasta que se resuelva `docs/20`, el costo de una re-autenticación es mínimo; si el volumen crece antes de implementar, se reevalúa.

**D8. Logs.** Ningún log incluye el token, su hash ni el `user_id` junto con una sesión. Los eventos nuevos (`sessions_purged`) llevan solo conteos.

## 4. Diseño

```
src/lib/auth/session.ts
  createSession(db, userId, ahora?)      -> token en claro (para la cookie); inserta sha256(token)
  getSessionUser(db, token, ahora?)      -> User | null     (D2: una consulta con JOIN)
  deleteSession(db, token)               -> borra la fila de ese hash
  deleteUserSessions(db, userId)         -> borra todas las de un usuario (habilitada, sin UI)
  purgeExpiredSessions(db, ahora?, tope) -> cantidad borrada
```

Quién cambia:

| Archivo | Cambio |
| --- | --- |
| `drizzle/schema.ts` y `drizzle/migrations/NNNN_sesiones.sql` | Tabla e índices. Migración **solo aditiva** |
| `src/middleware.ts` | Un `getSessionUser` en lugar de `getSession` (KV) + consulta de usuario |
| `src/pages/api/auth/callback/[provider].ts` | `createSession(db, user.id)` en lugar de `createSession(env.KV, ...)` |
| `src/pages/api/auth/logout.ts` | `deleteSession(db, token)` |
| `src/pages/api/cuenta.ts` | Se elimina el paso de KV y el `try/catch`; las sesiones caen por cascada |
| `src/lib/observability/run-sync.ts` | Llama a `purgeExpiredSessions` al final del sync |
| `src/lib/auth/index.ts` | Reexporta la API nueva |
| `scripts/e2e-server.mjs` | Siembra las sesiones de e2e en D1 con el hash correspondiente en lugar de en KV |

La cookie `session` no cambia: mismo nombre, mismo valor, mismos atributos. El número de la migración es el siguiente libre al implementar (hoy sería la `0008`; el TDD 16 (rate limiting) también prevé una tabla nueva, así que se coordina el orden al implementar).

## 5. Estrategia de tests (test primero: rojo, verde, refactor)

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| S1 | `createSession` | Inserta una fila con `id = sha256(token)` (el token **no** aparece en la tabla), `expires_at = ahora + 30 días`; el token tiene 43 caracteres base64url |
| S2 | `getSessionUser` con un token válido | Devuelve el usuario dueño |
| S3 | Token desconocido o vacío | `null` |
| S4 | Sesión expirada (reloj fijo) | `null` aunque la fila exista |
| S5 | Usuario borrado | La sesión no resuelve y no quedan filas huérfanas (conteo) |
| S6 | `deleteSession` | Borra solo la fila de ese token |
| S7 | `deleteUserSessions` | Borra todas las de ese usuario y ninguna de otro |
| S8 | Middleware con cookie válida | Pone `locals.user` con **una sola consulta** a D1 y sin tocar KV |
| S9 | Middleware con cookie inválida o expirada | Sin usuario y borra la cookie |
| S10 | **Regresión del incidente:** callback de login | Crea la sesión y la cookie con **0 operaciones de KV** |
| S11 | `logout` | Borra la fila y la cookie; 0 operaciones de KV |
| S12 | `DELETE /api/cuenta` | Las sesiones del usuario desaparecen por cascada; sin llamada a KV; reemplaza al caso C14 de `docs/14` |
| S13 | Limpieza dentro de `runSync` | Borra las vencidas, conserva las vigentes, respeta el tope y no falla sin filas |
| S14 | Dos sesiones del mismo usuario (dos dispositivos) | Dos filas; el logout de una no invalida la otra |
| S15 | La migración sobre una base con datos (0001 a 0007) | Aplica sin tocar `users` ni el resto; la tabla queda vacía |
| S16 | Logs de login, logout y limpieza | Sin token, hash ni `user_id` con la sesión |
| S17 | E2E (Playwright) con las sesiones sembradas en D1 | Todos los escenarios actuales siguen pasando |

**Tests existentes a actualizar** porque hoy asumen sesiones en KV: `tests/unit/auth/session.test.ts`, `tests/integration/auth/callback.test.ts`, `tests/integration/api/cuenta.test.ts` (C9 y C14), `tests/observability/cuenta-logs.test.ts` (el caso de fallo de KV deja de existir) y `tests/helpers/ctx.ts` (el uso de `kvEnMemoria` para sesiones). Cambia la precondición, no lo que se verifica.

Verde: la suite completa (`npm run check`). Refactor: borrar el prefijo `session:` y el TTL de KV y las referencias a `KVNamespace` en `session.ts`.

## 6. Despliegue y rollback

**Orden:**

1. Aplicar la migración de D1 **antes** del deploy (`deploy.yml` ya lo hace). Es aditiva: el código viejo la ignora.
2. Desplegar. Las sesiones de KV dejan de valer (D7): cada persona inicia sesión una vez.
3. Verificar: login con Google y con Microsoft, una acción autenticada, logout, y que `/api/health` siga en `ok`. En el dashboard de KV, las escrituras ya no crecen con los logins.

**Rollback:** volver al deployment anterior. El código viejo vuelve a leer sesiones de KV; las sesiones creadas por el código nuevo existen solo en D1, así que esas personas tienen que volver a iniciar sesión. La tabla nueva queda sin uso y no estorba. **Sin pérdida de datos.**

**Coordinación con otros TDD:**

- `docs/20` (estado de OAuth en cookie, PR #33) es independiente y va primero: es el que resuelve el incidente.
- `docs/16` (rate limiting, aún sin publicar) también escribe en D1. Con los volúmenes del §1.2 el presupuesto de escrituras alcanza para ambos con holgura, pero la suma se revisa al implementar.
- Los cambios a `src/pages/api/cuenta.ts` y `session.ts` se rebasan sobre lo que haya en `development` (el cifrado de tokens, `docs/15`, también los toca).

## 7. Plan de implementación

0. **Spike (opcional, 15 minutos).** Medir si el problema P3 es real en producción: crear una sesión y leerla de inmediato desde otra ubicación. Si no se reproduce, P3 pierde peso pero la decisión se sostiene por P1, P2, P4 y P5.
1. Tests en rojo: S1 a S7 y S13 sobre el módulo `session.ts`, con D1 de Miniflare y reloj fijo.
2. Migración y `schema.ts` (S15). `session.ts` nuevo. Verde de los unitarios y de S15.
3. Middleware (S8, S9). Callback y logout (S10, S11, S14).
4. `api/cuenta.ts`: se quita el paso de KV y el `try/catch`; el caso S12 reemplaza a C14.
5. Limpieza en `run-sync.ts` (S13) y logs (S16).
6. Actualizar los tests existentes del §5 y la siembra de `scripts/e2e-server.mjs` (S17).
7. Documentar en `docs/03-autenticacion.md` y `docs/02-base-de-datos.md`, y completar el §10 de este documento.

## 8. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| **R1. Dependencia de D1 en cada request autenticada** | No es una dependencia nueva: hoy el middleware ya consulta D1 para cargar el usuario. Sin D1 no hay usuario ni datos con ninguno de los dos diseños |
| **R2. Presupuesto de lecturas de D1** | ~2 filas por request autenticada, sobre un uso de 2 % a 5 % del límite diario (§1.2). Se agrega la métrica al seguimiento de `docs/16` §8 |
| **R3. La tabla crece si falla la limpieza** | `expires_at` filtra en la consulta, el índice la mantiene barata y `/api/admin/status` puede exponer el conteo de sesiones vencidas |
| **R4. Bug en el hash dejaría a todos sin sesión** | S1 a S4 fijan el contrato (el token no está en la tabla; el hash es determinístico); S17 prueba el flujo de punta a punta |
| **R5. Un re-login masivo al desplegar** | Con pocos usuarios no importa. Si ya hubiera muchos, se evalúa la lectura doble transitoria (D7) |
| **R6. Un deploy de la migración sin el código nuevo** | Es inocuo: tabla vacía y sin uso |
| **R7. La cascada no se aplica en producción** | Ya cubierto por el conteo de huérfanos de `docs/14` (C4) y por S5 y S12 |

## 9. Preguntas abiertas

- **Q1.** ¿Se acepta que, al desplegar, todas las sesiones actuales se pierdan (D7), o se prefiere la lectura doble transitoria?
- **Q2.** ¿Conviene exponer en `/api/admin/status` el conteo de sesiones vigentes y vencidas? Propuesta: sí, es una línea (R3).
- **Q3.** ¿Se construye ahora "cerrar sesión en todos los dispositivos" o queda para después? Propuesta: después (no objetivo).

## 10. Notas de implementación (desvíos respecto del diseño original)

*(Vacía hasta que se apruebe el TDD y empiece la implementación.)*
