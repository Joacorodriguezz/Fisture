# TDD: Borrado de cuenta por el propio usuario

> Technical Design Document. Estado: **implementado** (ver §9). Fecha: 2026-10-22. Rama de implementación: `feat/borrado-de-cuenta`, desde `development`.
>
> Este documento registra **qué problema hay hoy, qué decidimos y por qué**. El código y los tests se escriben después de que se apruebe, siguiendo el orden del §8.

## 1. Contexto y problema

La política de privacidad (`src/pages/privacidad.astro`, §6 y §7) promete que, al pedir el borrado, se eliminan los datos personales y las credenciales. Hoy el único camino es **escribir un email** y borrar a mano en D1. No existe ningún endpoint ni botón que lo haga.

Eso es un problema para abrir la app a todo el mundo:

- Google exige para apps con scopes sensibles que el usuario pueda borrar sus datos, y la revisión lo verifica.
- La Ley 25.326 (derecho de supresión) y el sentido común piden que sea autoservicio, no una gestión manual.
- Borrar a mano en D1 es propenso a errores y no revoca el acceso al calendario.

### 1.1 Qué datos hay de un usuario

| Dónde | Qué | Cómo se borra hoy |
| --- | --- | --- |
| D1 `users` | email, nombre, foto, `provider_id`, `access_token`, `refresh_token` | A mano |
| D1 `user_teams`, `user_preferences`, `calendar_syncs` | equipos, preferencias, partidos sincronizados | Caen solos por `ON DELETE CASCADE` al borrar el `users` |
| KV `session:<id>` | `userId` de cada sesión abierta (TTL 30 días) | Solo la de logout; el resto vence solo |
| Calendario del usuario (Google/Outlook) | Eventos de partidos creados por FISTURE | No se tocan (la política dice que quedan) |
| Proveedor OAuth | El consentimiento (grant) que dio al iniciar sesión | Lo revoca el usuario por su cuenta |
| Logs | Requests y errores, sin datos personales (el logger enmascara claves sensibles) | Expiran con la retención de Cloudflare |

## 2. Objetivos y no objetivos

**Objetivos**

1. Un usuario con sesión puede eliminar su cuenta desde Configuración, sin intervención nuestra.
2. El borrado es **completo y atómico** en D1: se van el usuario y todo lo que cuelga de él, o no se va nada.
3. Se intenta **revocar el consentimiento** en el proveedor (Google) para que los tokens dejen de servir.
4. Después de borrar, la sesión deja de funcionar de inmediato y el email puede volver a registrarse como cuenta nueva y limpia.
5. Cada caso del §4 tiene un test automático escrito **antes** de la implementación.

**No objetivos**

- Quitar del calendario del usuario los eventos ya creados (ver D4).
- Período de gracia o "deshacer" (ver D6).
- Exportar los datos antes de borrar (portabilidad). Queda en §10.
- Borrado administrativo de terceros (por ahora sigue siendo por email y a mano).

## 3. Diseño

### 3.1 Flujo

```
Configuración ── "Eliminar mi cuenta" ──► diálogo: escribir el email para confirmar
                                              │
                                              ▼  DELETE /api/cuenta  { confirmar: "<email>" }
                              ┌───────────────────────────────────────┐
                              │ 1. valida sesión, Origin y confirmación│
                              │ 2. lee refresh token en memoria         │
                              │ 3. db.batch: DELETE FROM users          │  ← cascade a todo lo demás
                              │ 4. KV: borra la sesión actual           │
                              │ 5. revoca el token en el proveedor      │  ← best-effort
                              │ 6. borra la cookie y responde 200       │
                              └───────────────────────────────────────┘
                                              │
                                              ▼
                                   redirige a /?cuenta=eliminada
```

### 3.2 Decisiones

**D1. `DELETE /api/cuenta`, protegido con `withApi`.**
Sigue la convención de `pages/api/` (nombres en español como `/api/preferencias`). Exige sesión: el middleware ya responde 401 a `/api/*` sin usuario, y `/api/cuenta` **no** va en `APIS_PUBLICAS`.

**D2. Confirmación escribiendo el email.**
El cuerpo trae `{ "confirmar": "<email>" }` y debe coincidir (sin distinguir mayúsculas) con el email del usuario de la sesión. Evita borrados por un clic accidental y por requests forjados. La UI es un diálogo con un campo de texto que habilita el botón solo cuando coincide; el servidor **vuelve a validarlo**.
*Alternativa descartada:* un `confirm()` del navegador. No protege contra requests directos y no se puede testear bien.

**D3. Borrado en D1 con una sola sentencia y cascada.**
`DELETE FROM users WHERE id = ?`. Las FK `user_teams`, `calendar_syncs` y `user_preferences` ya tienen `ON DELETE CASCADE` (`drizzle/schema.ts`). Una sola sentencia es atómica en D1: no hay estado intermedio. No hace falta migración.
*Riesgo a cubrir con test:* que D1 efectivamente aplique las FK (`PRAGMA foreign_keys`) en el entorno de test y en producción. El test de integración cuenta filas huérfanas después de borrar.
*Alternativa descartada:* borrar tabla por tabla. Más código, y deja estados parciales si falla a la mitad.

**D4. No se borran los eventos del calendario del usuario.**
Coincide con lo que ya promete la política ("los eventos que ya están en tu calendario quedan ahí") y evita dos problemas: Workers limita las subrequests por invocación (un usuario con cientos de partidos no entraría) y el borrado quedaría a medio hacer si algo falla. El diálogo lo dice explícitamente.
*Alternativa:* casilla "quitar también los eventos de mi calendario" con borrado en lotes. Queda en §10 como mejora; exige trabajo en segundo plano (cola o cron).

**D5. Revocar el consentimiento es best-effort y va después del borrado en D1.**
Orden: primero D1, después el proveedor. Si fuera al revés y la base fallara, el usuario perdería el acceso sin haber borrado nada. Con este orden, lo peor que puede pasar es que el token quede vigente en Google sin que nosotros tengamos copia (la fila ya no existe y el token solo estuvo en memoria): inofensivo para nosotros y revocable por el usuario.

| Proveedor | Cómo | Nota |
| --- | --- | --- |
| Google | `POST https://oauth2.googleapis.com/revoke` con el refresh token (revoca el grant entero) | Arctic ya lo ofrece: `google.revokeToken(token)` |
| Microsoft | **No hay** endpoint público para revocar el refresh token de cuentas personales con los scopes que pedimos | Se le indica en el diálogo que revoque el acceso en `account.live.com/consent/Manage` |

Un error al revocar **no** falla la request: se loguea (`account_revoke_failed`, con `provider` y `status`, nunca el token) y se sigue. El logger ya enmascara claves con `token`.

**D6. Borrado inmediato, sin período de gracia.**
Es lo más simple y lo que dice la política. Un período de gracia obligaría a guardar datos de alguien que pidió que los borremos, y a un job que los purgue. La fricción de D2 compensa el riesgo de error.

**D7. Las sesiones se invalidan solas.**
KV no permite listar `session:*` por usuario, así que **no** se intenta borrarlas todas. No hace falta: el middleware (`src/middleware.ts`) busca el usuario por `userId` en cada request y, si no existe, borra la cookie. Los `session:<id>` huérfanos solo contienen un UUID que ya no existe y vencen a los 30 días. Se borra explícitamente la sesión actual para no dejar rastro inmediato. Los `users.id` son `randomUUID`, no se reutilizan.

**D8. Protección contra requests forjados.**
La cookie es `sameSite=lax`, así que un `fetch` cross-site con método `DELETE` no la lleva. Además el endpoint exige `Content-Type: application/json` y, si viene el header `Origin`, que coincida con `PUBLIC_APP_URL`. Un helper `esMismoOrigen(request, env)` en `lib/auth/guards.ts` queda reutilizable para el punto de rate limiting y CSRF de la lista de pendientes de producción.

**D9. Logs sin datos personales.**
Se loguea `account_deleted` con `provider` y la cantidad de filas borradas por tabla. **No** se loguea el email, el nombre ni el `userId`.

**D10. Texto legal y UI.**
- `privacidad.astro` §6 y §7: el borrado pasa a ser autoservicio desde Configuración (el email queda como alternativa). Se actualiza `LEGAL_ACTUALIZADO` en `lib/legal.ts`.
- `configuracion.astro`: sección "Zona de peligro" con la isla `EliminarCuenta.tsx` (`client:visible`), con diálogo accesible (`<dialog>`, foco atrapado, Escape cierra).
- Tras borrar, redirige a `/?cuenta=eliminada` y la portada muestra un aviso breve.

## 4. Casos a cubrir

| ID | Caso | Comportamiento esperado |
| --- | --- | --- |
| C1 | Sin sesión | `401`, no se borra nada |
| C2 | Cuerpo sin `confirmar` o JSON inválido | `400` |
| C3 | `confirmar` no coincide con el email | `400`, no se borra nada |
| C4 | Confirmación correcta (distinta capitalización) | `200`; desaparecen `users`, `user_teams`, `user_preferences` y `calendar_syncs` del usuario |
| C5 | Hay otros usuarios con datos similares | Solo se borran los del usuario de la sesión |
| C6 | Falla la revocación en el proveedor | `200` igual; se loguea sin el token |
| C7 | Usuario de Microsoft | No intenta revocar; `200` |
| C8 | Usuario sin refresh token | `200`, sin intentar revocar |
| C9 | La sesión usada antes del borrado | Ya no pasa el middleware (cookie borrada, KV borrado) |
| C10 | Mismo email vuelve a iniciar sesión | Se crea un usuario nuevo, sin equipos ni preferencias viejas |
| C11 | `Origin` de otro sitio | `403`, no se borra nada |
| C12 | Los logs de la operación | Sin email, nombre, `userId` ni token |
| C13 | Falla el `DELETE` en D1 | `500` uniforme (`withApi`), no se revoca nada, la sesión sigue |

## 5. Estrategia de tests (test primero)

Se escribe cada test en **rojo**, se implementa lo mínimo para **verde** y se refactoriza. Se reutilizan los helpers de `tests/helpers` (`callApi`, D1 efímera de Miniflare, `fixtures`).

| Archivo | Cubre |
| --- | --- |
| `tests/integration/api/cuenta.test.ts` | C1 a C5, C7, C8, C10, C11, C13 contra D1 real de Miniflare (incluye conteo de filas huérfanas) |
| `tests/unit/auth/revoke.test.ts` | C6, C7, C8: revocación con `fetch` simulado (Google sí, Microsoft no) |
| `tests/unit/auth/guards.test.ts` (extiende) | `esMismoOrigen` |
| `tests/observability/` (extiende) | C12: no aparecen email ni token en los logs |
| `tests/e2e/critical-flows.spec.ts` (extiende) | Flujo completo en escritorio y móvil: abrir diálogo, botón deshabilitado hasta escribir el email, borrado y vuelta a la portada |

## 6. Plan de implementación

1. Tests de integración de `DELETE /api/cuenta` en rojo (C1 a C5, C10, C13).
2. Handler `src/pages/api/cuenta.ts` con `withApi`: validación, `DELETE` en D1, sesión y cookie. Verde.
3. `lib/auth/revoke.ts` (revocación por proveedor) y sus tests (C6 a C8). Se integra en el handler.
4. `esMismoOrigen` en `guards.ts` y C11.
5. Isla `EliminarCuenta.tsx`, sección en `configuracion.astro` y aviso en la portada. Test E2E.
6. Textos de `privacidad.astro` y `lib/legal.ts`.
7. Doc: actualizar `docs/03-autenticacion.md` y completar las notas de implementación (§9).

## 7. Despliegue y rollback

- **Migraciones D1:** ninguna.
- **Variables nuevas:** ninguna.
- **Rollback:** revertir el commit. No deja datos que migrar.
- El cambio de texto legal se publica junto con la funcionalidad (no antes, para no prometer algo que no existe).

## 8. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Borrado irreversible por error | Confirmación escribiendo el email (D2) y texto claro en el diálogo |
| La cascada no se aplica en producción | Test de integración con conteo de huérfanos; verificación manual con una cuenta de prueba antes del release |
| Token de Google queda vigente si falla la revocación | Aceptado (D5): no tenemos copia; el usuario puede revocar en su cuenta |
| Microsoft no se puede revocar desde acá | Se informa al usuario con el enlace; no es un bloqueo para la verificación |
| Sesiones huérfanas en KV | Inofensivas (D7), vencen a los 30 días |

## 9. Notas de implementación

Desvíos y decisiones tomadas durante la implementación:

- **Cascada verificada.** D1/Miniflare aplica las FK: el test cuenta 1 fila en `user_teams`, `user_preferences` y `calendar_syncs` antes de borrar y 0 después, sin huérfanas, sin borrar nada a mano. No hizo falta `PRAGMA foreign_keys`.
- **Batch en vez de una sola sentencia.** `lib/db/account.ts` usa un `DB.batch` (transacción) con tres `COUNT(*)` y el `DELETE FROM users`, para loguear las filas borradas por tabla (D9) sin perder atomicidad. Los conteos salen de las tablas dependientes, no de `meta.changes` (que solo cuenta el `DELETE` del usuario).
- **`userId` en el log.** `withApi` agrega `userId` al log "request" si `locals.user` existe, lo que contradice D9/C12. En vez de borrar `locals.user` (frágil: si algo lanzaba después del `DELETE`, el 500 podía loguear el userId), el handler fija `locals.omitirUserIdEnLog = true` al autenticarse, antes del `DELETE`, y `withApi` lo respeta en el log de request y en el de excepción 500. Dos tests lo cubren: `with-api.test.ts` y `cuenta-logs.test.ts` (fallo de KV después del `DELETE`).
- **415 para Content-Type.** D8 no fijaba el código; se eligió `415` cuando el `Content-Type` no es `application/json`. `esMismoOrigen` deja pasar requests sin `Origin` (curl, tests) y rechaza cualquier `Origin` distinto, incluido `null`.
- **Validación en el handler.** El `401` sin sesión lo da el handler (como `preferencias.ts`) además del middleware; `/api/cuenta` no está en `APIS_PUBLICAS`. Un `confirmar` con espacios alrededor se recorta antes de comparar.
- **Tests de revocación con `fetch` simulado** contra el `Google` real de Arctic. Un 400 con cuerpo OAuth llega como `OAuth2RequestError` (sin `status`), por eso en ese caso se loguea solo `provider`; un 5xx llega con `status`.
- **Revocación con el refresh token** leído de `locals.user` (cargado por el middleware), sin consulta extra.
- **E2E.** Se sumó el escenario `delete-account` al seed de `scripts/e2e-server.mjs` (un usuario por proyecto y reintento). Los E2E nuevos (borrado completo y cancelar el diálogo) usan usuarios propios (`delete-account` y `delete-cancel`): compartir el usuario `preferences` con el test de preferencias volvía inestable toda la suite. Suite E2E completa: 37 pasaron, 9 omitidos (por proyecto).
- **Cobertura.** `revoke.ts`, `account.ts` y `api/cuenta.ts` se agregaron a `coverage.include` en `vitest.config.ts`.
- **Texto legal.** `privacidad.astro` §6 y §7 describen el borrado autoservicio, el email queda como alternativa; `LEGAL_ACTUALIZADO` pasó a "22 de octubre de 2026".
- **Base de la rama.** `feat/borrado-de-cuenta` se creó desde el commit `72d2241` (que solo agrega los TDD `docs/14` y `docs/15`), no desde `development`; la infraestructura de tests ya estaba en `development`.
- **Riesgo: origen del request.** `esMismoOrigen` compara el `Origin` contra `PUBLIC_APP_URL`, así que entrar por un dominio propio, `www.` o un alias `*.fisture.pages.dev` devuelve 403 al borrar la cuenta. Declararlo en "Despliegue y riesgos" del PR y coordinarlo con `docs/16`.

## 10. Fuera de alcance (fases siguientes)

- Casilla "quitar también mis eventos del calendario" con borrado en segundo plano.
- Exportar los datos del usuario (portabilidad).
- Período de gracia con recuperación de cuenta.
- Borrado de terceros desde el panel de administración.
