# TDD: Casos borde del calendario (eventos existentes y reprogramaciones)

> Technical Design Document. Estado: **propuesto** (nada implementado todavía). Fecha: 2026-10-21. Rama de implementación sugerida: `feat/calendario-casos-borde`, desde `development`.
>
> Este documento registra **qué problemas hay hoy, qué decidimos y por qué**. El código y los tests se escriben después, siguiendo el orden del §11.

## 1. Contexto y problema

Hoy un partido se agrega al calendario del usuario (Google o Microsoft) con `syncMatches` (`src/lib/calendar/sync-service.ts`). El evento se guarda en `calendar_syncs` (`external_event_id`, `status`, `synced_date_time`). Hay dos preguntas abiertas:

1. **Evento que ya existe.** ¿Qué pasa si el usuario "agrega" un partido y en su calendario ya hay un evento? Puede ser el mismo evento de FISTURE (doble clic, fila perdida, evento borrado a mano), o un evento ajeno que se superpone.
2. **Actualización automática.** Si un partido se reprograma, se posterga o se cancela, ¿el evento del calendario se corrige solo? Hoy **solo en parte**: se detecta únicamente el cambio de fecha/hora, y el evento se corrige solo si el usuario tiene auto-sync activado en algún equipo. En Apple (.ics) nunca se corrige.

### 1.1 Brechas detectadas en el código actual

| # | Brecha | Dónde | Consecuencia |
| --- | --- | --- | --- |
| G1 | Cualquier error al actualizar (`catch {}`) termina en `create` | `sync-service.ts:161-164` | Un 429, un 5xx o un corte de red **duplican** el evento en el calendario |
| G2 | Google actualiza con `PUT` (reemplaza el evento entero) | `google.ts:72-95` | Se pierden las ediciones del usuario (notas, color, invitados) y se pisan sus recordatorios |
| G3 | `saveState` lee y después escribe; el índice `(user_id, match_id)` **no es único** | `sync-service.ts:104-120`, `schema.ts:177` | Dos requests concurrentes (doble clic, cron + usuario) crean dos eventos y dos filas |
| G4 | Si no hay fila pero el evento existe en el calendario, no se busca | `sync-service.ts:165-167` | Fila perdida o cuenta re-vinculada: evento duplicado |
| G5 | Si el usuario borró el evento, se lo recrea en silencio al reprogramar | `sync-service.ts:161-164` | Se le "resucita" un evento que quitó a propósito |
| G6 | Solo se compara `dateTime`; sede, `postponed` y `cancelled` no cuentan | `sync-service.ts:216-233` | Un partido cancelado sigue en el calendario como si se jugara |
| G7 | El cron solo mira usuarios con `auto_sync` en algún equipo | `sync-service.ts:238-242`, `queries.ts:128` | Un evento agregado a mano nunca se corrige: queda marcado `needs_update` y nadie lo actualiza |
| G8 | `selectDistinct ... limit(20)` sin `ORDER BY` | `sync-service.ts:238-242` | Con más de 20 usuarios, algunos no se procesan nunca |
| G9 | Un token revocado se trata como error de cada partido | `sync-service.ts:178-188` | N llamadas fallidas, N filas en `failed`, y la reconexión no las recupera de forma limpia |
| G10 | `.ics` sin `SEQUENCE` ni `STATUS` | `ics.ts:41-64` | Reimportar un partido reprogramado no actualiza el evento en Apple; un cancelado no se marca |
| G11 | `markOutdatedEvents` marca pasados | `sync-service.ts:216-233` | Se gastan llamadas en corregir partidos que ya se jugaron |

> `docs/05-integracion-calendarios.md` describe una versión anterior (`service.ts`, firmas distintas). La referencia es el código; ese documento se actualiza en el último paso (§11).

## 2. Objetivos y no objetivos

**Objetivos**

1. Agregar un partido es **idempotente**: repetirlo, concurrente o no, deja un solo evento.
2. Nunca se duplica un evento por un error transitorio.
3. Una reprogramación, postergación o cancelación se refleja en el calendario sin que el usuario haga nada, para **todos** los eventos creados por FISTURE.
4. Se respeta lo que el usuario hace en su calendario: lo que edita se conserva y lo que borra no se resucita en forma automática.
5. Cada caso del §4 y del §5 tiene al menos un test automático escrito **antes** de la implementación.

**No objetivos**

- Detectar eventos ajenos que "parecen" el mismo partido (ver decisión D6).
- Suscripción por URL (`webcal://`) para Apple: es la única forma de que Apple se actualice sola, queda como fase siguiente (§12).
- Notificar al usuario por mail o push de que su partido cambió (§12).
- Cambios en la UI más allá de los estados del §9.

## 3. Modelo de estados

`calendar_syncs.status` pasa de 4 a 6 valores:

| Estado | Significado | ¿El cron lo toca? |
| --- | --- | --- |
| `pending` | Fila sin evento todavía | Solo si el equipo tiene auto-sync |
| `synced` | Evento creado y al día | No |
| `needs_update` | El partido cambió respecto de lo que está en el calendario | **Sí, siempre** (G7) |
| `failed` | Último intento falló por un error transitorio; conserva `external_event_id` | Sí (reintento) |
| `detached` | **Nuevo.** El usuario borró el evento desde su calendario | **No.** Solo un clic manual lo recrea |
| `cancelled` | **Nuevo.** El partido se canceló y el evento se quitó | No, hasta que el partido reviva |

Transiciones:

```
              clic / auto-sync                      cambia hora, sede o estado del partido
   pending ───────────────────► synced ─────────────────────────────────────────► needs_update
      ▲                          ▲  │                                                   │
      │                          │  │ el update devuelve 404/410                        │ cron / clic
      │                          │  ▼                                                   ▼
      │                          │ detached ──── clic manual ──► (crea de nuevo) ──► synced
      │                          │
      │   partido cancelado      │                 partido vuelve a 'scheduled'
   (DELETE de la fila) ◄── cancelled ◄── synced ──────────────────────► cancelled ──► needs_update ──► synced
                                                   (se borra el evento)
```

Errores transitorios: `synced|needs_update → failed` (sin tocar el evento) y vuelve a intentarse en la corrida siguiente. Error de autenticación: **no cambia el estado** (ver D4).

## 4. Casos borde: "ya tengo un evento"

| ID | Caso | Comportamiento esperado |
| --- | --- | --- |
| A1 | El mismo partido ya está `synced` y al día | No llama a la API, devuelve éxito |
| A2 | Doble clic o dos requests concurrentes | Un solo evento y una sola fila |
| A3 | No hay fila, pero el evento ya está en el calendario (fila perdida, cuenta re-vinculada) | Se **adopta** el evento existente; no se crea otro |
| A4 | El usuario borró el evento y después se reprograma el partido | `detached`; el cron no lo recrea; un clic manual sí |
| A5 | El usuario editó el evento (color, notas, recordatorios) y el partido se reprograma | Se actualiza solo lo que es de FISTURE; lo demás se conserva |
| A6 | Hay un evento ajeno que se superpone en horario | Se agrega igual y se devuelve un aviso con los eventos en conflicto |
| A7 | El usuario reimporta el `.ics` de un partido reprogramado | Mismo `UID` y `SEQUENCE` mayor: Apple lo trata como actualización, no como evento nuevo |
| A8 | `matchIds` trae el mismo id repetido | Se procesa una sola vez |
| A9 | El evento borrado en Google queda como `cancelled` con el mismo id y se intenta crear otra vez | Se **restaura** en lugar de fallar |

### 4.1 Decisiones

**D1. Id determinístico para el evento (idempotencia).**
Google admite que el cliente elija el id del evento (5 a 1024 caracteres de `a-v` y `0-9`). Se usa `fa` + los primeros 40 hex de `sha256(userId + ":" + matchId)`. Un segundo `create` con el mismo id devuelve `409`, y ahí se **adopta** el evento (A2, A3). Si el evento está `cancelled` (A9, el usuario lo borró antes), se restaura con `PATCH status: "confirmed"`.
Microsoft no permite elegir el id. Se manda `transactionId` (la API lo ofrece justamente para evitar `POST` repetidos) y se etiqueta el evento con una propiedad extendida `fisture.matchId`. Si hay una fila perdida, se busca por esa propiedad antes de crear (A3).
*Alternativas descartadas:* un candado en D1 (no cubre la fila perdida ni la cuenta re-vinculada) y buscar por título (frágil, ver D6).

**D2. Índice único `(user_id, match_id)` en `calendar_syncs`.**
Es la red de seguridad de A2: aunque dos requests pasen la verificación a la vez, la segunda inserción no puede crear una fila duplicada. `saveState` pasa a `INSERT ... ON CONFLICT DO UPDATE`. La migración elimina antes los duplicados existentes (§7).

**D3. Actualizar con `PATCH`, solo con los campos propios.**
Google deja de usar `PUT`. Se envían `summary`, `start`, `end`, `location` y la descripción base. **No** se envían `reminders` en una reprogramación: son del usuario desde que se creó el evento (A5). Microsoft ya usa `PATCH`.

**D4. Clasificación de errores en un solo lugar.**
Los clientes lanzan `CalendarApiError { status, retryAfter? }` en vez de `Error` genérico. `classifyCalendarError` devuelve uno de:

| Clase | Cuándo | Qué hace `syncMatches` |
| --- | --- | --- |
| `gone` | `404`/`410` al actualizar | Marca `detached` (D5). No recrea |
| `auth` | `401`, `invalid_grant`, token no renovable | **Corta** el bucle del usuario, no marca `failed`, no crea nada. Queda para cuando reconecte |
| `rate_limit` | `429`, o `403` con `rateLimitExceeded` | **Corta** el bucle del usuario; respeta `Retry-After`; no marca `failed` |
| `transient` | `5xx`, red | Marca `failed`, conserva `external_event_id`, **nunca** crea (G1). Reintenta en la corrida siguiente |
| `conflict` | `409` al crear | Adopta (D1) |
| `permanent` | resto de `4xx` | Marca `failed` con el mensaje |

**D5. Lo que el usuario borra, se respeta (`detached`).**
Si el update devuelve `gone`, se asume que el usuario quitó el evento a propósito. El cron no lo vuelve a crear (G5). Si más adelante pulsa "Agregar" a mano, se crea de nuevo: esa es una acción explícita.
*Costo aceptado:* si el evento se perdió por un motivo ajeno al usuario (por ejemplo, un calendario borrado), no vuelve solo; el usuario lo ve en la UI como "Agregar".

**D6. Los eventos ajenos nunca se tocan ni se buscan por similitud.**
Un evento creado por el usuario o por otra app, aunque se llame "Boca vs River", **no** se fusiona. Detectarlo por título/hora es una heurística con falsos positivos (borraríamos o editaríamos algo que no es nuestro) y exige leer más del calendario. Solo se opera sobre eventos propios: los que tienen nuestro id (Google) o nuestra propiedad (Microsoft).

**D7. Superposición con eventos ajenos: avisar, no bloquear (A6).**
Con un solo partido (clic del usuario), después de crear se consulta el calendario en la franja `[inicio, fin]` (`events.list` en Google, `calendarView` en Microsoft; los scopes actuales `calendar.events` y `Calendars.ReadWrite` alcanzan). La respuesta suma `warnings: [{ code: "overlap", count, items: [{ title, start, end }] }]`, con máximo 3 ítems.
- Solo en sincronización manual de **un** partido. En lotes y en el cron no se consulta (cuesta una subrequest por partido).
- Los títulos de eventos ajenos **no se loguean ni se guardan**: se devuelven al propio usuario y nada más.
- Se agrega igual porque ver dos partidos o una reunión a la vez es habitual, y el usuario puede quitarlo con el botón existente.

## 5. Casos borde: reprogramaciones y cambios de estado

| ID | Caso | Comportamiento esperado |
| --- | --- | --- |
| B1 | Cambia fecha u hora | `needs_update` → el cron hace `update` (no `create`) y guarda el nuevo `synced_date_time` |
| B2 | Cambia la sede | Igual que B1 |
| B3 | Se posterga (`postponed`) | Título con prefijo `[POSTERGADO]`; se conserva el horario viejo hasta que haya fecha nueva |
| B4 | Postergado que recibe fecha nueva | Se actualiza hora y se quita el prefijo |
| B5 | Se cancela (`cancelled`) | Se borra el evento; la fila queda `cancelled` con `external_event_id = NULL` |
| B6 | Un cancelado vuelve a `scheduled` | `needs_update` → se vuelve a crear |
| B7 | El partido ya se jugó | No se marca ni se actualiza (G11) |
| B8 | Usuario sin auto-sync, evento agregado a mano, partido reprogramado | El cron lo actualiza igual (G7) |
| B9 | El partido pasa a `live` o `finished` | **No** genera `needs_update` |
| B10 | Cambian hora y sede a la vez | Una sola llamada |
| B11 | El cambio lo detectan una vista de página y el cron | Una sola actualización; la segunda ve `synced` y no hace nada |
| B12 | Sin cambios | Cero llamadas a la API |

### 5.1 Decisiones

**D8. El "estado relevante" se deriva; no se guarda el estado crudo del partido.**
`live` y `finished` no cambian lo que se ve en el calendario, así que se mapean a `scheduled`. Solo `postponed` y `cancelled` cuentan:

```sql
-- estado que debería reflejar el evento
CASE WHEN m.status IN ('postponed','cancelled') THEN m.status ELSE 'scheduled' END
```

Se agregan dos columnas a `calendar_syncs`: `synced_state` y `synced_venue`, junto a `synced_date_time` (que ya existe). Un evento está desactualizado si cualquiera de las tres difiere (B1, B2, B3, B5, B9, B10). La comparación usa `IS NOT` para tratar bien los `NULL`, y la sede se normaliza con `NULLIF(venue, '')`.
*Alternativa descartada:* un hash del payload. SQLite no tiene `sha256` nativo y la detección debe seguir siendo un `UPDATE` set-based (decisión de `19ef46d`).

**D9. Solo partidos futuros.**
`markOutdatedEvents` ignora partidos con `date_time` anterior a ahora menos 3 horas (el mismo umbral de `stale_scheduled` en `docs/10`). Un partido jugado no se corrige (B7).

**D10. Cancelado: se borra el evento, no se marca.**
Un evento "Cancelado" en el calendario sigue ocupando espacio y recordando al usuario. Borrar es el comportamiento que espera quien eligió que la app maneje su calendario. La fila queda `cancelled` para que la UI diga "Partido cancelado" y para poder revivirlo (B6).
*Alternativa:* dejarlo con prefijo `[CANCELADO]`. Más conservador, pero deja basura. Se revisa si hay quejas (§12).

**D11. Postergado: se conserva el horario y se marca el título.**
No se sabe la fecha nueva, así que moverlo sería inventar un dato. El prefijo `[POSTERGADO]` avisa sin borrar. Cuando el proveedor publica la fecha nueva, B4 lo corrige.

**D12. Reconciliación para todos los usuarios con eventos desactualizados (G7, G8).**
`runCalendarAutoSync` pasa a ser `reconcileCalendars`:
1. `markOutdatedEvents` sin `userId` (una sola pasada set-based para todos). Se llama al terminar el sync de datos y no solo al ver una página.
2. Candidatos: usuarios con `needs_update` **o** con auto-sync, ordenados por cantidad de `needs_update` descendente, con `ORDER BY` explícito y límite `CRON_MAX_USERS` (G8).
3. Por usuario, primero los `needs_update`/`failed` y después las altas nuevas, dentro de `CRON_MATCHES_PER_USER`. Una corrección vale más que una alta.

**D13. Una sola actualización aunque haya varios detectores (B11).**
`upToDate` pasa a comparar las tres columnas contra el partido actual, así que el segundo detector (página o cron) encuentra `synced` y sale sin llamar a la API.

**D14. Apple (.ics): lo que sí se puede hacer sin suscripción.**
El `UID` ya es estable (`${match.id}@fisture.app`). Se agrega `SEQUENCE` (segundos de `matches.updated_at`, creciente y estable entre descargas), `LAST-MODIFIED`, `STATUS:CANCELLED` para cancelados y el prefijo `[POSTERGADO]` en `SUMMARY`. Así reimportar actualiza el evento en lugar de duplicarlo (A7). Importante: **sigue siendo manual**. La actualización automática en Apple requiere un feed por suscripción (§12) y no se promete en la UI.

## 6. Diseño del flujo nuevo de `syncMatches`

```
syncMatches(db, env, user, matchIds, deps?)
  ids = unique(matchIds)                                   ── A8
  client = deps?.client ?? getClient(user.provider)        ── costura para tests
  por cada id:
    match = getMatchDetail(id)            ¬ → "Partido no encontrado"
    estado = estadoRelevante(match)       // 'scheduled' | 'postponed' | 'cancelled'
    fila = SELECT calendar_syncs (user, match)

    si fila.status=synced y las tres columnas coinciden  → ok, 0 llamadas        ── A1, B12
    si fila.status=detached y la corrida es automática   → ok, se omite           ── A4, D5
    si estado=cancelled:
        si fila.externalEventId → client.remove(…)        // 404 tolerado
        guardar status=cancelled, externalEventId=NULL    ── B5
        continuar
    token = getValidAccessToken(…)        error auth → cortar bucle              ── D4
    si fila.externalEventId:
        try client.update(…)              // PATCH solo campos propios            ── D3
        catch gone      → status=detached (si automática) | create (si manual)    ── A4
        catch otro      → classify → failed / cortar bucle, NUNCA create          ── G1
    sino:
        id = client.create(…)             // id determinístico                    ── D1
        catch conflict  → adoptar (Google: GET/restaurar; MS: buscar por propiedad) ── A3, A9
    guardar: externalEventId, status=synced, synced_date_time/state/venue, lastSyncedAt
    si es manual y es el único id → warnings = client.overlaps(…)                 ── D7
```

La costura `deps.client` (y `deps.getToken`) permite probar toda la lógica contra un cliente falso, sin red. "Automática" significa que la llamó el cron (parámetro `mode: "auto" | "manual"`).

## 7. Cambios de datos (migración `0006_calendar_syncs_idempotencia.sql`)

```sql
-- Migration: 0006_calendar_syncs_idempotencia
-- Description: unicidad (user_id, match_id), columnas de estado sincronizado y estados detached/cancelled.

-- 1. Quitar duplicados: conservar, por (user_id, match_id), la fila synced con evento y la más reciente
DELETE FROM calendar_syncs WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY user_id, match_id
      ORDER BY (status = 'synced') DESC, (external_event_id IS NOT NULL) DESC, last_synced_at DESC
    ) AS rn FROM calendar_syncs
  ) WHERE rn > 1
);

-- 2. Unicidad (reemplaza el índice no único de la migración 0005)
DROP INDEX IF EXISTS idx_calendar_syncs_user_match;
CREATE UNIQUE INDEX uq_calendar_syncs_user_match ON calendar_syncs(user_id, match_id);

-- 3. Lo que tenía el evento cuando se sincronizó
ALTER TABLE calendar_syncs ADD COLUMN synced_state TEXT;
ALTER TABLE calendar_syncs ADD COLUMN synced_venue TEXT;

-- 4. Backfill: asumimos que los eventos sincronizados reflejan el partido actual (igual que 0005 con la fecha)
UPDATE calendar_syncs SET
  synced_state = 'scheduled',
  synced_venue = (SELECT NULLIF(venue, '') FROM matches WHERE matches.id = calendar_syncs.match_id)
WHERE status = 'synced';
```

Notas:
- Los eventos de las filas duplicadas que se descartan **quedan en el calendario del usuario**: la migración no tiene tokens para borrarlos. Es un caso raro; se acepta y se documenta en el release.
- `detached` y `cancelled` son valores nuevos de una columna `TEXT` sin `CHECK`, así que no requieren cambio de esquema.
- El helper de tests (`tests/helpers/d1.ts`) separa sentencias por `;`: la migración no debe llevar `;` dentro de textos ni triggers. La que arriba está bien.
- Se agrega `0006` a `MIGRACIONES` en `scripts/sync-check.mjs` y las columnas a `drizzle/schema.ts`.

## 8. Cambios en los clientes de calendario

- `CalendarApiError { status, retryAfter?, message }` en `google.ts` y `microsoft.ts` (hoy lanzan `Error` genérico y parsean el cuerpo, que puede no ser JSON).
- `google.ts`: `updateGoogleCalendarEvent` pasa a `PATCH`; `createGoogleCalendarEvent` acepta `id` y devuelve `409` como `conflict`; nueva `restoreGoogleCalendarEvent`; nueva `listGoogleOverlaps`. `extendedProperties.private.fisture = matchId` como etiqueta adicional.
- `microsoft.ts`: `transactionId` y propiedad extendida `fisture.matchId` al crear; `findMicrosoftEventByMatch` (filtro por la propiedad); `listMicrosoftOverlaps` con `calendarView`.
- `event-id.ts` (nuevo, función pura): `fistureEventId(userId, matchId)`.
- `errors.ts` (nuevo, función pura): `classifyCalendarError(error)`.
- `formatMatchFor*` reciben el estado relevante para aplicar el prefijo `[POSTERGADO]`.

> Los puntos sobre el comportamiento exacto de la API (restaurar un evento `cancelled` con el mismo id, filtro por propiedad extendida en Graph, `transactionId`) **se confirman con un spike contra las cuentas reales antes del paso 2** (§11). Si alguno no se comporta como se asume, se ajusta D1 y se registra en el §14.

## 9. Estados en la UI

Sin rediseño; solo qué muestra cada estado en `CalendarButton` y `/calendario`:

| Estado | Texto / acción |
| --- | --- |
| `synced` | "En calendario" |
| `needs_update` | "Reprogramado" y "Era: {synced_date_time}", botón "Actualizar" (el valor viejo ya está en la fila) |
| `failed` | Mensaje de error y "Reintentar" |
| `detached` | "Agregar" otra vez (D5) |
| `cancelled` | "Partido cancelado", sin botón |
| Respuesta con `warnings.overlap` | Aviso: "Se superpone con: …" |

## 10. Estrategia de pruebas (TDD)

Orden: **test en rojo, implementación en verde, refactor.** Se usan Vitest y la D1 efímera con Miniflare que ya existe (`tests/helpers/d1.ts`). Los clientes de calendario se prueban con un `CalendarClient` falso (costura `deps`) y los HTTP con `fetch` simulado (`vi.stubGlobal`). Ningún test llama a Google ni a Microsoft.

### 10.1 Tests por archivo

| Archivo | Caso | Test |
| --- | --- | --- |
| `tests/calendar/event-id.test.ts` (puro) | D1 | es determinístico; usa solo `a-v0-9`; largo entre 5 y 1024; cambia con `userId` o `matchId` |
| `tests/calendar/errors.test.ts` (puro) | D4 | `401`→`auth`; `404`/`410`→`gone`; `429`→`rate_limit` con `retryAfter`; `403 rateLimitExceeded`→`rate_limit`; `500`/red→`transient`; `409`→`conflict`; `400`→`permanent` |
| `tests/calendar/google-client.test.ts` | D3, A9 | `update` usa `PATCH` y **no** manda `reminders`; `create` manda el `id`; `409` se lanza como `conflict`; restaurar manda `status: "confirmed"` |
| `tests/calendar/microsoft-client.test.ts` | D1 | `create` manda `transactionId` y la propiedad extendida; la búsqueda filtra por `matchId` |
| `tests/calendar/sync-matches.test.ts` | A1 | `synced` y al día → 0 llamadas |
| | A2 | dos `syncMatches` en paralelo → una fila y un `create` efectivo |
| | A3 | sin fila y `create` devuelve `conflict` → se adopta, queda `synced` con ese id, sin segundo `create` |
| | A4 | `update` da `gone` en modo `auto` → `detached` y sin `create`; en modo `manual` → `create` y `synced` |
| | A6 | un partido manual con eventos superpuestos → `warnings.overlap`; en lote o `auto` → no consulta |
| | A8 | `[a, a]` → una sola llamada |
| | B1, B2 | hora o sede cambian → `update` (no `create`), con las tres columnas nuevas |
| | B3, B4 | `postponed` → título con prefijo y horario viejo; luego fecha nueva → hora nueva sin prefijo |
| | B5 | `cancelled` → `remove` + `cancelled` + `external_event_id` nulo; si el `remove` da `404`, igual queda `cancelled` |
| | B6 | `cancelled` que vuelve a `scheduled` → `create` |
| | B10, B12 | cambio doble → una llamada; sin cambio → ninguna |
| | G1 | `update` da `500`, `429` o error de red → `failed`, **0 `create`**, conserva `external_event_id` |
| | G9 | `auth` en el partido 1 de 5 → corta, 0 llamadas posteriores, estado sin pasar a `failed` |
| | C5 | un `permanent` en el partido 2 no frena el 3 |
| `tests/calendar-mark-outdated.test.ts` (se amplía el existente) | B2 | cambio de sede → `needs_update` |
| | B3, B5 | cambio a `postponed` o `cancelled` → `needs_update` |
| | B6 | fila `cancelled` con partido otra vez `scheduled` → `needs_update` |
| | B7 | partido pasado no se marca |
| | B9 | `live` y `finished` no marcan |
| | D12 | sin `userId` procesa a todos los usuarios; con `userId` solo a uno (los 3 casos actuales siguen verdes) |
| | `detached` | `detached` nunca se marca |
| `tests/calendar/reconcile.test.ts` | B8, D12 | usuario sin auto-sync con `needs_update` es candidato y se corrige |
| | G8 | con más usuarios que el límite se procesan primero los de más `needs_update` |
| | D12 | `needs_update` y `failed` se procesan antes que las altas dentro del presupuesto |
| | | el error de un usuario no frena a los demás |
| `tests/calendar/migration-0006.test.ts` | D2 | duplicados: queda la fila `synced` con evento; el índice único rechaza un duplicado nuevo; el backfill llena `synced_state` y `synced_venue` solo en `synced` |
| `tests/calendar/ics.test.ts` | A7, D14 | `UID` estable entre dos generaciones; `SEQUENCE` crece si cambia `updated_at`; cancelado lleva `STATUS:CANCELLED`; postergado lleva el prefijo |

### 10.2 Criterio de "terminado"

- Todos los tests nuevos y los 3 de `calendar-mark-outdated` pasan; `npm test` completo en verde.
- `npm run build` y `npm run sync:check` pasan (el segundo aplica la migración `0006`).
- Verificación manual con una cuenta de Google y una de Microsoft de prueba: agregar, hacer doble clic, borrar el evento a mano y reprogramar un partido en D1 local, comprobando que el resultado coincide con el §4 y el §5.

## 11. Plan de implementación

Cada paso es un commit (Conventional Commits) en `feat/calendario-casos-borde`; el PR a `development` se mergea con squash.

| # | Paso | Entregable |
| --- | --- | --- |
| 0 | Spike de las APIs | Confirmar id propio y restauración en Google, `transactionId` y propiedad extendida en Graph; anotar el resultado en el §14 |
| 1 | Datos | Tests de migración (rojo) + `0006`, `schema.ts`, `scripts/sync-check.mjs` |
| 2 | Errores y clientes | Tests + `errors.ts`, `event-id.ts`, `CalendarApiError`, Google en `PATCH`, id y etiquetas |
| 3 | `syncMatches` idempotente | Tests de A1 a A4, A8, G1, G9 + costura `deps` + `saveState` con upsert |
| 4 | Detección de cambios | Tests + `markOutdatedEvents` con estado, sede, futuros y revivir; `upToDate` de tres columnas |
| 5 | Postergado y cancelado | Tests de B3 a B6 + formato con prefijo + borrado |
| 6 | Reconciliación | Tests + `reconcileCalendars`, `ORDER BY`, prioridad de actualizaciones, `markOutdatedEvents` global tras el sync de datos |
| 7 | Superposición | Tests + `listGoogleOverlaps`/`listMicrosoftOverlaps` + `warnings` en `POST /api/calendario/sync` |
| 8 | `.ics` | Tests + `SEQUENCE`, `LAST-MODIFIED`, `STATUS`, prefijo |
| 9 | UI y documentación | Estados del §9; actualizar `docs/05` y `docs/02`; sumar el flujo a `CLAUDE.md` |

### Despliegue y rollback

1. Aplicar `0006` en producción **antes** del deploy (`npm run db:migrate:prod`). Es compatible con el código viejo: las columnas son nulas por defecto, el índice único no rompe al `saveState` anterior (que hace lectura y escritura) y `detached`/`cancelled` son solo valores de texto nuevos.
2. Deploy normal: PR `development` → `main`.
3. Rollback: revertir el merge. Las columnas y el índice pueden quedar sin uso. Las filas en `detached`/`cancelled` serían tratadas por el código viejo como estados desconocidos (no `synced`), así que el cron las volvería a ofrecer para sincronizar: es molesto pero no destructivo.

## 12. Después de esta iteración

- **Feed por suscripción para Apple** (`/api/calendario/feed/{token}.ics`, con token por usuario): es la única forma de que Apple Calendar se actualice sola.
- **Aviso al usuario** de que su partido cambió (sección "Reprogramados" en `/hoy` o un mail).
- **Debounce de reprogramaciones** si algún proveedor alterna entre horarios provisorios y reales.
- Revisar D10 (cancelado: borrar o marcar) según el uso real.
- Soporte de más de un calendario por usuario (hoy todo va a `primary`).

## 13. Riesgos y decisiones abiertas

| Tema | Decisión / riesgo |
| --- | --- |
| Presupuesto de subrequests | Cada actualización cuesta 1 llamada más la renovación de token; adoptar tras `409` suma un `GET`. Los límites actuales (`CRON_MAX_USERS = 20`, `CRON_MATCHES_PER_USER = 10`) se mantienen; la prioridad de D12 evita gastarlo en altas mientras haya correcciones pendientes |
| Alternancia de horarios del proveedor | Una oscilación entre dos horas genera una actualización por corrida. Aceptable por ahora (cron diario); ver debounce en §12 |
| Eventos huérfanos al deduplicar | Se aceptan (§7). Se informa en las notas del release |
| Evento `cancelled` de Google con el mismo id | Se asume que se puede restaurar con `PATCH`; lo confirma el spike del paso 0 |
| Privacidad | Los títulos de eventos ajenos (D7) solo se devuelven al propio usuario y jamás pasan por el logger; los logs siguen usando solo `userId` y `matchId` |
| Cambio manual de hora por el usuario | Se respeta hasta la próxima reprogramación real del partido; entonces FISTURE vuelve a escribir el horario (el partido manda sobre la hora) |
| Cambio de proveedor del usuario | `calendar_syncs.provider` puede no coincidir con `user.provider` si se re-vincula con otra cuenta; fuera de alcance. Se registra y se trata como fila perdida (A3) |

## 14. Notas de implementación

*(Se completa durante la implementación con los desvíos respecto de este diseño, igual que el §13 de `docs/10`. El resultado del spike del paso 0 va acá.)*
