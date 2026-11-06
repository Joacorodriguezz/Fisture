# TDD: Vinculación segura de cuentas OAuth

> Technical Design Document. Estado: **implementado (2026-11-03)**; desvíos en el §12. Fecha del diseño: 2026-10-22. Rama de implementación: `feat/vinculacion-de-cuentas`, desde `development`, **después** de `feat/borrado-de-cuenta` (TDD 14) y de `feat/cifrado-de-tokens` (TDD 15); ver §8.
>
> Este documento registra **qué problema hay hoy, qué decidimos y por qué**. El código y los tests se escriben después de que se apruebe, siguiendo el orden del §9. El análisis del §1 se hizo leyendo el código de `origin/development`; lo que no se pudo confirmar sin una cuenta real está marcado **a verificar** y se resuelve en el spike del paso 0.

## 1. Contexto y problema

Hoy el callback OAuth (`src/pages/api/auth/callback/[provider].ts`) decide **quién es el usuario por su email** y nada más. Un usuario "existe" si algún `users.email` coincide, sin mirar con qué proveedor entró ni su identificador estable en ese proveedor.

### 1.1 Qué hace el código (confirmado)

| # | Hecho | Dónde |
| --- | --- | --- |
| H1 | El usuario se busca con `eq(users.email, userInfo.email)`. No se consulta `provider` ni `provider_id` | `callback/[provider].ts:75-77` |
| H2 | Si existe, se le abre sesión **sin ningún chequeo adicional** y se le **pisan** `accessToken`, `refreshToken`, `tokenExpiresAt`, `name` e `image` con los del proveedor con el que acaba de entrar | `callback/[provider].ts:80-90`, sesión en `:115` |
| H3 | En Microsoft el email es `profile.mail \|\| profile.userPrincipalName`, leído de Graph `/me`. Ni `mail` ni el UPN son verificados por el proveedor | `callback/[provider].ts:57-63` |
| H4 | El tenant es `common`: acepta cuentas de **cualquier** tenant de Entra y cuentas personales. Crear un tenant propio es gratis | `src/lib/auth/providers.ts:13` |
| H5 | Para Google se usa `userinfo` v2 y se tipa sin `verified_email`; el campo **se ignora**. Tampoco se pide ni lee `hd` | `callback/[provider].ts:38-46` |
| H6 | `users.email` es único, pero `provider`/`provider_id` son una sola columna cada una: un usuario tiene **un** proveedor, el del primer ingreso, que nunca se actualiza | `drizzle/schema.ts:9-24` |
| H7 | `provider` decide qué cliente de calendario se usa (`getClient(user.provider)`), qué endpoint renueva el token (`getValidAccessToken`) y el texto de la UI (`providerLabel(user.provider)`) | `sync-service.ts:103`, `tokens.ts:33-41`, `configuracion.astro:73` |
| H8 | El `state` guarda `provider` en KV pero el callback **no** lo compara con `params.provider` | `login/[provider].ts:20`, `callback/[provider].ts:21-25` |
| H9 | `provider_id` se guarda pero **nunca se lee** para identificar a nadie | búsqueda en todo `src/` |

### 1.2 Escenarios (el ataque se confirma)

**Escenario A, toma de cuenta ("nOAuth").** Ana usa FISTURE con Google (`ana@gmail.com`, equipos favoritos, calendario conectado).

1. Un atacante crea un tenant de Entra propio (gratis) y un usuario en él.
2. Como administrador de su tenant, fija el atributo `mail` de ese usuario en `ana@gmail.com` (el `mail` es un atributo editable por el administrador del tenant; a confirmar en el spike que Entra no lo valida contra el dominio).
3. Entra en FISTURE con "Continuar con Microsoft". Graph devuelve `mail = ana@gmail.com`.
4. H1 encuentra a Ana por email, H2 le abre sesión **como Ana** y escribe los tokens de Microsoft del atacante en la fila de Ana.

Consecuencias, según el código real (hay que ajustar la hipótesis inicial de "heredar tokens"):

- El atacante **ve y modifica los datos de Ana**: equipos, preferencias, calendario, y puede disparar sincronizaciones.
- El código **no entrega** los tokens de Ana al atacante (los pisa, no los lee). Pero ningún endpoint devuelve la fila `users` completa, así que tampoco hay filtración directa de tokens por la API (se revisó `locals.user` en `src/pages/api/**`).
- **Daño colateral y exfiltración indirecta**: los tokens de Ana quedan reemplazados por los del atacante. Si Ana era de Microsoft (`provider = 'microsoft'`), el cron `reconcileCalendars` y cada "agregar al calendario" escriben **los partidos de Ana en el calendario del atacante**. Si Ana era de Google, `getValidAccessToken` intenta renovar un token de Microsoft contra Google y falla: la sincronización de Ana queda rota hasta que reingrese.
- Ana no recibe ningún aviso.

**Escenario B, pre-secuestro.** El atacante entra primero con Microsoft y el email de Ana (que todavía no se registró). Crea la cuenta con ese email. Cuando Ana entra con Google, H1 la "encuentra" y la deja dentro de la cuenta del atacante, que seguirá teniendo acceso por Microsoft.

**Escenario C, el mismo usuario con dos proveedores (hoy).** Ana entra con Google y otro día con Microsoft con el mismo email: H1 la reconoce, pero H2 le pisa los tokens de Google con los de Microsoft mientras `provider` sigue diciendo `google`. El calendario deja de funcionar sin explicación (mismo síntoma que el daño colateral anterior, sin atacante). Si los emails difieren, se crean dos cuentas separadas sin forma de unirlas.

### 1.3 Qué dicen los proveedores (documentación vigente)

- **Microsoft** (ID token claims reference, Microsoft Learn): `email` "isn't guaranteed to be correct and is mutable over time. Never use it for authorization or to save data for a user". `preferred_username` es mutable y no sirve para decisiones de autorización. `oid` es "the immutable identifier for an object" y no se reutiliza; Graph lo devuelve como `id` del usuario. `sub` es inmutable pero **pairwise por aplicación**. `oid` es distinto en cada tenant (un mismo humano en dos tenants son dos cuentas distintas). La guía dice usar `sub` u `oid` "alone"; `tid` sirve para enrutar.
- **`xms_edov`** (claim opcional, fuentes secundarias: Clerk, Descope, Prelude): indica si el dominio del email está verificado; se emite `true` para dominios verificados del tenant o cuentas personales con email verificado al crearse, y `false` o ausente si el email es editable. Requiere configurarlo en el registro de la app. **A verificar** (spike §9, paso 0): el comportamiento exacto con cuentas personales y la configuración necesaria en el manifest, porque no se pudo confirmar contra la página oficial de optional claims.
- **Google** (OpenID Connect): `sub` es "unique among all Google Accounts and never reused" y debe usarse como clave ("Always use the `sub` field as it is unique to a Google Account even if the user changes their email address"). El email "may not be unique to this account and could change over time". `email_verified` indica si Google verificó el email. `hd` identifica el dominio de Workspace.

Conclusión: la clave de identidad correcta es `(provider, id estable)`, y el email es un **atributo** que solo sirve para unir cuentas cuando el proveedor garantiza que está verificado.

## 2. Objetivos y no objetivos

**Objetivos**

1. La identidad de un login es `(provider, provider_id)` con el identificador inmutable (`sub` de Google, `oid`/`id` de Microsoft). El email nunca identifica a nadie por sí solo.
2. Los tokens son **por identidad**: entrar con otro proveedor nunca pisa los de otro.
3. Una política explícita y testeada de cuándo un login nuevo se asocia a una cuenta existente: automática solo si **ambos** lados están verificados por su proveedor; si no, el usuario ya autenticado lo confirma desde Configuración.
4. Ante un conflicto de email, el usuario ve una explicación accionable y no se abre ninguna sesión.
5. La migración conserva los ids de `users`, las sesiones en KV y todo `calendar_syncs`.
6. Hay un test que reproduce el Escenario A y falla hoy; cada caso del §5 tiene un test escrito **antes** de la implementación.

**No objetivos**

- Soportar varios calendarios activos a la vez. Sigue habiendo **un** proveedor de calendario por usuario (`users.provider`, ver D4); cambiarlo desde la UI queda en §11.
- Unir cuentas ya existentes que hoy están duplicadas (mismo humano, emails distintos). Se resuelve a mano o con la vinculación manual de D3.
- Restringir tenants de Microsoft (`common` se mantiene; ver D8).
- Agregar proveedores nuevos (Apple, etc.). El modelo los admite, pero no se implementan acá.
- Pedir verificación de email propio (envío de códigos). Ver D7.

## 3. Diseño

### 3.1 Modelo de datos

Tabla nueva `oauth_identities` (una fila por cuenta de proveedor vinculada):

| Columna | Tipo | Notas |
| --- | --- | --- |
| `id` | text PK | UUID. Para la identidad principal (la que crea la migración desde `users`) vale `id = users.id`; las identidades nuevas reciben un UUID propio. Es el `<identityId>` del AAD del cifrado (TDD 15): `<id>:<columna>` |
| `user_id` | text NOT NULL | FK a `users(id)` **ON DELETE CASCADE** |
| `provider` | text NOT NULL | `'google'` o `'microsoft'` |
| `provider_id` | text NOT NULL | Google: `sub`. Microsoft: `oid` (Graph `id`) |
| `tenant_id` | text | Microsoft: `tid`. Informativo (distingue cuenta personal `9188040d-...` de trabajo) |
| `email` | text | Email **tal como lo informó el proveedor**, normalizado (§3.3). Se actualiza en cada login |
| `email_verified` | integer NOT NULL DEFAULT 0 | 1 solo si el proveedor lo garantiza (D2) |
| `access_token`, `refresh_token`, `token_expires_at` | text, text, integer | Pasan de `users` a acá |
| `created_at`, `last_login_at` | integer | |

Índices: `UNIQUE (provider, provider_id)` (la clave de identidad), `UNIQUE (user_id, provider)` (una identidad por proveedor y usuario en esta versión), `INDEX (user_id)`.

Cambios en `users`:

- `email_verified` integer NOT NULL DEFAULT 0: el email de la cuenta fue verificado por algún proveedor (copiado de la identidad que la creó).
- `provider` pasa a significar **proveedor de calendario activo** (D4). `provider_id`, `access_token`, `refresh_token`, `token_expires_at` quedan **deprecadas**: se mantienen en el release de transición (D6) y se eliminan en un release posterior.
- `email` sigue único y pasa a ser el **email de contacto** de la cuenta: se fija al crearla y no lo cambia el login (D5).

### 3.2 Flujo del callback

```
callback(provider, code, state)
  1. valida state; stored.provider === params.provider (H8)
  2. valida el código y obtiene la identidad del proveedor:
       google:    id_token  -> sub, email, email_verified, hd
       microsoft: Graph /me -> id (= oid), name;  id_token -> oid, tid, email?, xms_edov?
  3. intent = stored.intent ("login" | "link")

  intent = login
  4. identidad por (provider, provider_id)?
       sí  -> user = su dueño. Actualiza SOLO los tokens, name, image y email de
              esa identidad. NO toca users.email ni otras identidades. Sesión.
       no  -> fallback legado (D6): users WHERE provider=? AND provider_id=?
              (clave estable, no email). Si existe, crea la identidad y sigue como "sí".
  5. identidad nueva y sin fallback:
       email ausente o vacío            -> error email_ausente, sin sesión
       cuenta con ese email (normalizado)?
         no  -> crea user + identidad. users.email_verified = identidad.email_verified
         sí  -> política D2/D3:
                 identidad.email_verified Y user.email_verified -> vincula (auto) + sesión
                 si no                                          -> error email_en_uso, sin sesión

  intent = link   (el usuario ya tiene sesión)
  6. exige sesión vigente y que sea la del state.userId
       identidad ya existe en OTRO usuario -> error identidad_en_uso (no se fusionan cuentas)
       identidad ya existe en este usuario -> actualiza tokens
       no existe                           -> la asocia a este usuario (el email puede ser distinto)
```

Vincular desde Configuración es `POST /api/auth/vincular/[provider]` (valida sesión y `Origin`, igual que el resto de las mutaciones): guarda en KV `{ codeVerifier, provider, intent: "link", userId }` con TTL de 10 min y redirige al proveedor. El callback es el mismo endpoint.

### 3.3 Normalización del email

`trim` + minúsculas (`toLowerCase()`, sin tocar puntos ni `+alias`: no se asume que `a.b@gmail.com` y `ab@gmail.com` sean la misma persona). Se aplica al leer del proveedor y en la migración. La unicidad de `users.email` se mantiene, ahora sobre el valor normalizado, con un índice único sobre `lower(email)` por si algún código viejo escribe sin normalizar.

## 4. Decisiones

**D1. La identidad es `(provider, provider_id)`, en una tabla aparte.**
Un usuario puede tener varias identidades; cada una guarda sus tokens. Resuelve H1, H2, H6 y el Escenario C de raíz: ya no hay un lugar donde un login de un proveedor pueda pisar a otro.
*Alternativas descartadas:* (a) **solo cambiar el lookup** a `(provider, provider_id)` sobre `users` y rechazar al segundo proveedor: cierra el ataque pero deja a un mismo humano con dos cuentas o bloqueado, y no permite tener dos proveedores. (b) **Una columna por proveedor en `users`** (`google_id`, `microsoft_id`, tokens duplicados): no escala a Apple, duplica columnas de tokens y complica el cifrado y el borrado. (c) **Dejar el email como clave pero exigir `email_verified`**: depende de que cada proveedor lo emita bien; Microsoft no lo garantiza (D2).

**D2. Qué cuenta como "email verificado".**
- Google: `email_verified === true` del ID token (no de Graph ni de `userinfo` v2). Si falta o es `false`, no está verificado.
- Microsoft: solo si el ID token trae `xms_edov === true` (y el claim `email`). **Mientras el spike no confirme que `xms_edov` se emite de forma fiable (incluidas cuentas personales), Microsoft se trata siempre como no verificado.** Nunca se usa `mail` de Graph ni el UPN para unir cuentas.
- Una identidad no verificada puede crear una cuenta (con `users.email_verified = 0`) pero **nunca** se asocia sola a una cuenta existente.
*Alternativas descartadas:* confiar en el dominio del email (`@gmail.com` implica Google): el email lo controla el administrador del tenant, el dominio no prueba nada; exigir `hd` de Workspace: excluye a casi todos los usuarios.

**D3. Cuándo se vincula un segundo proveedor.**
1. **Automático** solo si la identidad nueva está verificada **y** la cuenta existente tiene `email_verified = 1`. Caso típico: la persona entra con Google y otro día con Microsoft verificado (o al revés). Ambos proveedores atestiguan el mismo email.
2. **Manual, confirmado por el dueño**, en cualquier otro caso: el usuario entra con su proveedor original y pulsa "Vincular Microsoft" en Configuración; como ya está autenticado y además autentica en el segundo proveedor, no hace falta que los emails coincidan ni que estén verificados.
3. Nunca se fusionan dos cuentas existentes: si la identidad ya pertenece a otro usuario, error `identidad_en_uso`.
*Alternativa descartada:* **solo vinculación manual** (la más conservadora). Es la opción más segura, pero hace que el caso común (Google y Microsoft con el mismo email verificado) termine en un error y obliga a todos a pasar por Configuración. Se elige la regla 1 porque exige verificación en **ambos** lados; si el dueño prefiere cero automatismo, se desactiva con un flag y el resto del diseño no cambia (§11).
*Alternativa descartada:* **correo de confirmación** al email de la cuenta: requiere un servicio de envío que el proyecto no tiene (Cloudflare Email Service es posible a futuro).

**D4. El proveedor de calendario sigue siendo uno: `users.provider`.**
`users.provider` queda como "proveedor de calendario activo" y apunta a una identidad existente. Los tokens que usan `getValidAccessToken`, `reconcileCalendars` y la sync salen de `oauth_identities WHERE user_id = ? AND provider = users.provider`. Una identidad vinculada que no es la activa sirve para entrar, pero sus eventos no se tocan. `calendar_syncs.provider` ya existe y no cambia. Si el usuario desvincula la identidad activa se le exige elegir otra antes (D9).
*Alternativa descartada:* sincronizar con ambos calendarios a la vez: duplica la superficie del TDD 11 (idempotencia, reconciliación) sin que nadie lo haya pedido.

**D5. El login no modifica `users.email` ni `users.provider`.**
Si el email cambia en el proveedor, se actualiza `oauth_identities.email` (informativo) y la cuenta sigue siendo la misma porque la clave es el id estable. `users.email` es el de contacto; un cambio de email de contacto es una feature aparte (§11).

**D6. Migración en dos releases (expand y contract) con lookup legado.**
Release N: migración aditiva (tabla nueva + backfill desde `users`) y código que lee `oauth_identities`, con **fallback** por `users.provider/provider_id` (que son claves estables, no email) y **doble escritura** de tokens a `users.*` para la identidad igual a `users.provider`. Eso cubre dos huecos: (a) el intervalo entre migrar (el deploy aplica las migraciones **antes** de subir el artefacto) y desplegar el código nuevo, y (b) un rollback del código, que volvería a leer tokens frescos en `users.*`. Release N+1: se eliminan el fallback, la doble escritura y las columnas viejas. 

Con el TDD 15 ya implementado, la doble escritura cifra dos veces: en `users.*` y en `oauth_identities`. Para la identidad principal el AAD es el mismo (`id = users.id`) y cada escritura usa un IV nuevo, así que los dos textos cifrados son distintos pero ambos descifran con el mismo AAD.
*Alternativa descartada:* migración destructiva en un solo paso: el rollback del código quedaría con columnas vacías o inexistentes.

**D7. Sin verificación de email propia.**
No se envían códigos. La verificación la aportan los proveedores (D2) o el usuario autenticado (D3.2).

**D8. `common` se mantiene.**
Restringir a un tenant dejaría afuera a casi todos los usuarios y a las cuentas personales. La defensa del nOAuth es no usar el email para identificar ni unir (D1, D2), no limitar tenants. Se registra el `tid` para distinguir cuenta personal de trabajo y para diagnóstico.

**D9. Desvincular.**
`DELETE /api/auth/identidades/[provider]` (sesión + `Origin`). Se rechaza si es la **última** identidad o si es la activa de calendario sin otra de reemplazo (el usuario cambia `users.provider` antes: `PATCH` mínimo incluido en el paso 7). Al desvincular se descifra el token de esa identidad con el helper de lectura del TDD 15 y se revoca con el mismo helper del TDD 14 (best-effort). Sin esto, una vinculación hecha por error o tras un robo de sesión no tendría vuelta atrás.

**D10. Endurecimientos menores incluidos.**
Comparar `stored.provider` con `params.provider` (H8); la identidad de Google sale del ID token (`sub`, `email_verified`) en lugar de `userinfo` v2; el login nunca reemplaza `refresh_token` por vacío si el proveedor no lo reenvía (Google solo lo manda al consentir; hoy `prompt=consent` lo fuerza, pero Microsoft puede omitirlo). 

### 4.1 Qué ve el usuario ante un conflicto (`/login?error=...`)

| Código | Cuándo | Mensaje (resumen) | Acción ofrecida |
| --- | --- | --- | --- |
| `email_en_uso` | Hay una cuenta con ese email y no se puede unir sola (D3) | "Ya existe una cuenta de FISTURE con este email, creada con **{proveedor}**. Por seguridad no la unimos sin tu confirmación." | Botón "Ingresar con {proveedor}" y texto: "Una vez adentro, vinculá este proveedor desde Configuración" |
| `identidad_en_uso` | Al vincular, esa cuenta del proveedor ya es de otro usuario | "Esa cuenta de {proveedor} ya está asociada a otro usuario de FISTURE." | Volver a Configuración |
| `email_ausente` | El proveedor no entregó email | "No pudimos obtener un email de tu cuenta de {proveedor}. Probá con otro proveedor." | Volver al login |
| `vinculo_sesion` | Intento de vincular sin sesión vigente o con otro usuario | "Tu sesión cambió. Volvé a intentarlo." | Volver a Configuración |

El mensaje de `email_en_uso` nombra el proveedor de la cuenta existente: es una fuga mínima (confirma que el email está registrado) que acepta quien puede probar con ese email de todos modos; **no** se muestran nombre, foto ni datos de la cuenta. Es una decisión a confirmar (§10).

## 5. Casos a cubrir

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| V-01 | **Ataque nOAuth:** cuenta de Ana (Google) existe; llega Microsoft nuevo con `mail = ana@...` sin `xms_edov` | Sin sesión de Ana; `email_en_uso`; la fila y los tokens de Ana intactos |
| V-02 | Ana existe con Microsoft; atacante con **otro** `oid` y el mismo `mail` | Igual que V-01; los tokens de Ana no se pisan |
| V-03 | Reingreso de la misma identidad `(provider, provider_id)` | Misma cuenta; actualiza tokens, nombre e imagen **de esa identidad**; sin duplicados |
| V-04 | Google verificado entra a una cuenta Microsoft **no** verificada del mismo email | `email_en_uso` (el lado existente no está verificado) |
| V-05 | Google verificado entra a una cuenta con `email_verified = 1` del mismo email | Se crea la identidad Google en esa cuenta; ambas conservan sus tokens |
| V-06 | Google con `email_verified = false` | Si el email coincide, `email_en_uso`; si no, crea cuenta con `email_verified = 0` |
| V-07 | Microsoft con `xms_edov = true` y cuenta existente verificada | Vincula automáticamente (solo si el spike del paso 0 lo habilita; si no, V-01) |
| V-08 | Segundo proveedor con la cuenta existente **no** verificada, pero el usuario vincula desde Configuración | Se vincula aunque el email difiera |
| V-09 | Vincular con una identidad que ya es de otro usuario | `identidad_en_uso`; no se fusiona nada |
| V-10 | Vincular sin sesión, con sesión de otro usuario o con `state` reutilizado | `vinculo_sesion`; el `state` es de un solo uso |
| V-11 | El email cambia en el proveedor (mismo `sub`/`oid`) | Entra a la misma cuenta; `identity.email` se actualiza; `users.email` no |
| V-12 | Cuenta Microsoft personal (`tid = 9188040d-...`) vs. de trabajo: mismo humano, `oid` distinto | Son identidades distintas; solo se unen por V-05, V-07 o V-08 |
| V-13 | Email vacío, ausente o solo espacios | `email_ausente`; no se crea usuario ni sesión |
| V-14 | Mismo email con otra capitalización (`Ana@Gmail.com` vs `ana@gmail.com`) | Se normaliza: se trata como el mismo email en todas las reglas |
| V-15 | Segundo proveedor vinculado: no se pisan los tokens ni `users.provider` | La sync de calendario sigue usando la identidad activa |
| V-16 | `stored.provider` distinto de `params.provider` | `invalid_state`, sin llamar al proveedor |
| V-17 | Pre-secuestro (Escenario B): cuenta creada con identidad no verificada; la dueña real entra con Google verificado | No hereda la cuenta del atacante: se crea cuenta nueva y el email de la cuenta no verificada se libera (renombrado a `<id>@sin-verificar.invalid`, ver §10) |
| V-18 | Migración: cada usuario existente obtiene exactamente una identidad con sus tokens | `COUNT(identidades) = COUNT(users)`; sin duplicados `(provider, provider_id)` |
| V-19 | Migración: `calendar_syncs`, `user_teams`, `user_preferences` y sesiones en KV siguen válidos | Mismos `user_id`; ninguna sesión se invalida |
| V-20 | Fallback legado: usuario con identidad faltante (migrado antes del deploy o tras un rollback) | Se crea la identidad por `provider/provider_id`, no por email |
| V-21 | Desvincular la última identidad o la activa sin reemplazo | Rechazado; el resto, permitido y con revocación |
| V-22 | Borrar la cuenta con dos identidades (TDD 14) | Cae todo por cascade y se revocan los tokens de **todas** las identidades, descifrando cada uno con el helper de lectura del TDD 15 antes de revocar |

## 6. Estrategia de pruebas (TDD)

Se usa la infraestructura existente: Vitest con D1 efímera de Miniflare (`tests/helpers/use-test-db.ts`), `apiCtx` y `kvEnMemoria` de `tests/helpers/ctx.ts`, y el patrón de `tests/integration/auth/callback.test.ts`, que mockea `lib/auth/providers` y `fetch`.

**Tests que existen hoy** (`tests/integration/auth/callback.test.ts`, `tests/unit/auth/login.test.ts`, `login-next.test.ts`, `guards.test.ts`, `session.test.ts`): cubren `state`, `next`, alta, reingreso por email (`"usuario existente: no duplica y actualiza tokens y nombre"`) y el orden `mail`/UPN de Microsoft. Dos de ellos **fijan el comportamiento vulnerable** y se reescriben en el paso 2: el reingreso por email y `"Microsoft con mail lo prefiere sobre userPrincipalName"` (el email ya no decide identidad ni se toma de Graph).

**Paso 1, rojo.** Archivo nuevo `tests/integration/auth/vinculacion.test.ts`. El test central **reproduce el ataque y falla hoy**:

```
V-01  dado un usuario Ana (google, g-1, ana@example.com, tokens "at-ana"/"rt-ana")
      cuando el callback de microsoft recibe {id:"m-evil", mail:"ana@example.com"} sin xms_edov
      entonces redirige a /login?error=email_en_uso
        y no se llama a cookies.set ni se crea session:* en KV
        y la fila de Ana conserva access_token "at-ana" y refresh_token "rt-ana"
```

Hoy falla en las tres aserciones (H1 y H2). Lo mismo para V-02. El resto de los casos del §5 se escriben en rojo antes de implementar. Los ID tokens se simulan con un helper `idToken({ sub, email, email_verified, oid, tid, xms_edov })` que arma un JWT sin firma y lo expone vía `tokens.idToken()` del mock.

**Paso 2, verde.** Se implementa en el orden del §9 hasta que cada caso pase; no se agrega comportamiento sin un test rojo antes.

**Paso 3, refactor.** Extraer a `src/lib/auth/identity.ts` funciones puras y testeadas aparte (`normalizarEmail`, `emailVerificado(provider, claims)`, `decidirVinculo({identidad, cuentaExistente})` que devuelve `login | crear | vincular | conflicto`). La tabla de decisión se prueba con `it.each` (unit, sin D1).

**Migración:** `tests/integration/migracion-identidades.test.ts` aplica `0001..0007`, inserta usuarios de prueba (Google, Microsoft, emails con mayúsculas, uno con `calendar_syncs`), aplica la migración nueva y verifica V-18 y V-19 y `PRAGMA foreign_key_check`. Una segunda prueba aplica la migración sobre **dos usuarios cuyo email difiere solo en mayúsculas** y comprueba que el script falla de forma explícita (ver §8).

**E2E (Playwright):** no se agrega flujo real contra proveedores; solo se cubre la pantalla de error `email_en_uso` y la sección de Configuración (con identidades sembradas).

**Cobertura:** `callback/[provider].ts` y `identity.ts` deben quedar dentro de los umbrales de `npm run test:coverage`.

## 7. Cambios de superficie

| Archivo | Cambio |
| --- | --- |
| `drizzle/schema.ts`, `drizzle/migrations/` | Tabla `oauth_identities`, columna `users.email_verified`, índices |
| `src/lib/auth/identity.ts` (nuevo) | Normalización, verificación, decisión de vínculo, alta/vínculo de identidades |
| `src/pages/api/auth/callback/[provider].ts` | Flujo del §3.2; deja de buscar por email |
| `src/pages/api/auth/login/[provider].ts` | Guarda `intent` en el `state`; Microsoft pide `xms_edov` según el spike |
| `src/pages/api/auth/vincular/[provider].ts`, `.../identidades/[provider].ts` (nuevos) | Iniciar vinculación y desvincular, con `withApi` |
| `src/lib/auth/tokens.ts`, `src/lib/calendar/sync-service.ts` | Leen tokens de la identidad activa (D4) |
| `src/middleware.ts` | Carga las identidades junto al usuario (sin exponerlas a las vistas) |
| `src/pages/configuracion.astro`, `src/pages/login.astro` | Lista de identidades y botones; mensajes de error del §4.1 |
| `src/lib/observability/consistency.ts` | Chequeos: usuarios sin identidad, identidades huérfanas, `users.provider` sin identidad correspondiente |
| `docs/03-autenticacion.md`, `docs/02-base-de-datos.md`, `CLAUDE.md` | Documentar el modelo y la política |

## 8. Orden de implementación y conflictos con los TDD 14 y 15

Los tres TDD tocan el callback y las columnas de tokens. **Orden acordado: 14 (borrado) → 15 (cifrado) → 18 (esta).**

| Punto de conflicto | 14 borrado de cuenta | 15 cifrado de tokens |
| --- | --- | --- |
| `callback/[provider].ts` | No lo toca directamente, pero lee el refresh token del usuario | Cifra al escribir `accessToken`/`refreshToken` |
| Dónde viven los tokens | `DELETE` lee `users.refresh_token` para revocar | Cifra `users.access_token` y `users.refresh_token` |
| Con este TDD | La revocación debe recorrer **todas** las identidades (V-22), descifrando cada token con el helper de lectura de 15 antes de revocar; el `DELETE FROM users` ya cae por cascade si la FK es `ON DELETE CASCADE` | El AAD es `<userId>:<columna>` y se mantiene. Con 18, la identidad principal tiene `id = users.id`, así que el AAD sigue válido; las identidades nuevas usan `<identityId>:<columna>` |

Razonamiento: con 15 antes que 18, los tokens ya están cifrados en `users.*` con AAD `<userId>:<columna>`. Como la identidad principal de `oauth_identities` tiene `id = users.id`, el backfill del §3 copia los `enc:v1:...` tal cual con `INSERT ... SELECT`: el AAD sigue siendo válido y no hace falta descifrar ni re-cifrar en la migración. Solo las identidades nuevas (vinculadas con 18) reciben UUID propio y cifran con `<identityId>:<columna>`. 14 va primero porque es independiente y lo pide la verificación de Google; su extensión a todas las identidades (V-22) se hace en el paso 8 del §9, cuando el helper de lectura de 15 ya existe.

Acciones concretas:

1. El TDD 15 no cambia su AAD: sigue siendo `<userId>:<columna>`. Este documento agrega la regla para identidades nuevas (`<identityId>:<columna>`). El TDD 15 debe exponer el helper de lectura (descifrado por identidad) que usan V-22, la desvinculación y la doble escritura.
2. 14 se implementa tal cual y recibe en este TDD su extensión: revocar los tokens de todas las identidades, descifrando cada uno antes (paso 8 del §9).
3. Con el orden acordado no hace falta script de re-cifrado: el backfill copia los `enc:v1:...` por SQL (ver §10). Un cambio posterior de AAD sería un re-cifrado con script y se planifica aparte.
4. Las tres ramas modifican `callback/[provider].ts` y su test: el que entra segundo rebasa sobre `development` y resuelve los conflictos a mano. Mergear de a una, sin ramas paralelas largas.
5. Los números de migración (hoy el último es `0007`) los toma cada rama al implementarse; si dos coinciden, renumera la que se mergea después y se vuelve a generar con `npm run db:generate`.

## 9. Plan de implementación

Cada paso es un commit dentro de `feat/vinculacion-de-cuentas`; el PR a `development` se mergea con squash. Los tests de cada paso se escriben primero.

| # | Paso | Entregable |
| --- | --- | --- |
| 0 | **Spike** (sin código de producción) | Con una cuenta Google, una Microsoft personal y una de trabajo de un tenant propio: (a) `id` de Google `userinfo` v2 == `sub` del ID token; (b) `id` de Graph `/me` == `oid` del ID token, en cuenta personal y de trabajo; (c) si `xms_edov` llega, con qué valor y qué configuración de manifest hace falta; (d) con un tenant propio, fijar `mail` ajeno y confirmar que Graph y el ID token lo reflejan sin `xms_edov = true`; (e) que `decodeIdToken` de Arctic alcanza para leer los claims. El resultado se anota en §12 y decide si V-07 queda activo |
| 1 | Rojo | `vinculacion.test.ts` con V-01 a V-17 (V-01 y V-02 reproducen el ataque), helpers de ID token |
| 2 | Esquema y migración | `oauth_identities` (identidad principal con `id = users.id`), `users.email_verified`, backfill por SQL sin re-cifrar, test de migración (V-18, V-19) |
| 3 | `identity.ts` | Normalización, `emailVerificado`, `decidirVinculo`; tests unitarios con `it.each` |
| 4 | Callback | Flujo del §3.2 para `intent = login`, fallback legado y doble escritura (D6); V-01 a V-06, V-11 a V-16, V-20 en verde. Se reescriben los dos tests vulnerables |
| 5 | Tokens y calendario | `getValidAccessToken` y la sync leen de la identidad activa (V-15) |
| 6 | Vincular | `intent = link`, `POST /api/auth/vincular/[provider]` (V-08 a V-10) |
| 7 | Desvincular y UI | `DELETE .../identidades/[provider]`, cambio de proveedor activo, Configuración y mensajes del §4.1 (V-21) |
| 8 | Borrado y consistencia | Extender TDD 14: revocar todas las identidades (V-22); chequeos de `consistency.ts` |
| 9 | Cierre | Actualizar `docs/02`, `docs/03`, `CLAUDE.md`; completar §12 de este documento; `npm run check` |
| 10 | Release N+1 (posterior) | Eliminar fallback, doble escritura y columnas viejas de `users` |

## 10. Despliegue y rollback

**Antes de desplegar (probar la migración con datos reales).**

1. `npx wrangler d1 export fisture --remote --output=copia.sql` (exportación de producción, **solo en la máquina local; contiene tokens: no subirla ni commitearla**, borrarla al terminar).
2. Cargarla en una D1 local vacía (`wrangler d1 execute fisture --local --file=copia.sql`), aplicar `npm run db:migrate:local` y correr las consultas de verificación: `COUNT` de identidades igual al de usuarios; ningún `(provider, provider_id)` repetido; `PRAGMA foreign_key_check` vacío; ningún par de `users.email` que difiera solo en mayúsculas (si existe, la migración **aborta** y se resuelve a mano antes); conteo de `calendar_syncs` igual al previo; y todos los `enc:v1:...` copiados a `oauth_identities` descifran con el AAD `<id>:<columna>` de su fila (script con el helper de lectura de 15).
3. Con esa copia, levantar `npm run dev` y comprobar a mano un login de cada proveedor y una sincronización.
4. Anotar el bookmark de Time Travel de D1 inmediatamente antes de migrar producción (`wrangler d1 time-travel info`).

**Orden en producción.** El deploy aplica las migraciones **antes** de subir el artefacto; por eso la migración es **solo aditiva** y el código viejo sigue funcionando con ella. Los usuarios que se creen en esa ventana quedan sin identidad: los cubre el fallback legado de D6 (V-20) y el chequeo de consistencia. El backfill marca `email_verified = 1` para usuarios `google` (el email de Google lo verificó Google; supuesto a confirmar en el spike) y `0` para `microsoft`; los de Microsoft vinculan por la vía manual (D3.2).

**Rollback.**

- *Código:* revertir el merge. Gracias a la doble escritura, `users.access_token`/`refresh_token` siguen vigentes y el código viejo funciona: el código al que se vuelve es el de 15, que lee `users.*` cifrado con el mismo AAD. La tabla `oauth_identities` queda sin uso, sin daño.
- *Esquema:* solo si hiciera falta, una migración inversa (`DROP TABLE oauth_identities`, `ALTER TABLE users DROP COLUMN email_verified`). No se hace en caliente.
- *Datos:* si la migración de datos saliera mal, restaurar al bookmark de Time Travel anotado. Las sesiones en KV no se tocan en ningún escenario.
- Release N+1 (borrar columnas) **no** tiene rollback sencillo: solo se hace tras varios días estables en N y con un export previo.

**Aviso a usuarios.** Ninguno es necesario: las sesiones y los datos se conservan. Quien hoy tenga la cuenta "mezclada" (Escenario C) puede reingresar para regenerar los tokens.

## 11. Riesgos y decisiones abiertas

| Tema | Decisión / riesgo |
| --- | --- |
| `xms_edov` no confiable o inexistente para personales | Microsoft nunca auto-vincula y solo vincula a mano. Impacto: algo más de fricción, ninguna brecha. Se confirma en el spike |
| Google: reciclaje de dominios o email de Workspace ajeno | `email_verified` no prueba propiedad **hoy** si el dominio caducó y lo compra otro. Riesgo residual bajo y común a toda la industria; se deja el flag para desactivar el auto-vínculo |
| Usuarios Microsoft existentes marcados `email_verified = 0` | No pueden auto-vincular; vinculan a mano. Aceptado |
| Enumeración de cuentas por `email_en_uso` | Se revela el proveedor, no datos personales. **A confirmar por el dueño** |
| Pre-secuestro (V-17) | Liberar el email de la cuenta no verificada (renombrándolo) es una decisión de producto: pierde la cuenta del atacante, pero la cuenta real tendría un huérfano. **A confirmar** |
| Unicidad de `lower(email)` | Si producción tiene colisiones por capitalización la migración aborta; se resuelve a mano antes |
| `users.provider` apuntando a una identidad inexistente | Lo detecta el chequeo de consistencia; el callback lo repara con el fallback |
| Doble escritura temporal | Duplica tokens cifrados (TDD 15) un release más, en `users.*` y en `oauth_identities`. Se acota: la identidad principal usa el mismo AAD (`id = users.id`) y cada escritura lleva IV nuevo, así que no hay reutilización de nonce; las columnas viejas se borran en N+1 |
| Límite de D1 por lote en el backfill | El `INSERT ... SELECT` es una sola sentencia; sin listas de parámetros |
| Decisiones que necesita el dueño | (1) ¿auto-vincular con ambos lados verificados (D3.1) o solo manual? (2) Mensaje de `email_en_uso` con nombre de proveedor (§4.1). (3) Liberar el email en V-17. (4) Si se quiere poder **cambiar** el calendario activo en este mismo release o después. (5) Orden 14 → 15 → 18 (§8), acordado: el TDD 15 no cambia su AAD |

## 12. Notas de implementación

Implementado el 2026-11-03 en `feat/vinculacion-de-cuentas`, aprobado el TDD tal como estaba. Desvíos y decisiones:

**Spike del paso 0 (no se pudo hacer).** Requiere cuentas reales (Google, Microsoft personal y un tenant propio de Entra). Se aplicó lo que el propio TDD recomienda y la opción que falla cerrado:

- Microsoft se trata **siempre como no verificado**: `MICROSOFT_XMS_EDOV_CONFIABLE = false` en `src/lib/auth/identity.ts` (D2). El claim `xms_edov` no se pide ni se usa. V-07 queda como test de que **no** se auto-vincula aunque llegue `xms_edov = true`; para activarlo, tras el spike, basta cambiar la constante (`emailVerificado` ya soporta `confiarXmsEdov`) y pedir el claim en el manifest.
- Se asume `id` de Graph `/me` == `oid` (D1), con la normalización de la revisión (ver más abajo). Si el ID token trae un `oid` que no corresponde al `id` de Graph el login falla cerrado (`oauth_failed`). El `tid` se lee del ID token y es solo informativo.
- La identidad de Google sale del ID token decodificado con `decodeIdToken` de Arctic (suficiente para leer los claims, pregunta (e)); ya no se llama a `userinfo` v2. El ID token llega directo del endpoint de tokens de Google por TLS, de ahí que no se verifique la firma (igual que antes con el access token).
- El backfill marca `email_verified = 1` para usuarios `google` (supuesto del TDD sin confirmar con una cuenta real).

**Actualización (2026-11-05): el Release A del TDD 15 ya cifra los tokens de `users.*` y de `oauth_identities` (AAD `<id>:<columna>`), y la revocación los descifra; lo que sigue es el estado al implementar este TDD.** Se implementó esto de forma independiente: los tokens se guardaban en claro, tanto en `oauth_identities` como en `users.*`. El backfill copia las columnas tal cual (`INSERT ... SELECT`), así que cuando se implemente el 15 deberá cifrar también `oauth_identities` con AAD `<id>:<columna>` (la identidad principal tiene `id = users.id`). Las secciones de V-22 y D9 que hablan de "descifrar con el helper de lectura de 15" no aplican todavía: la revocación usa el token leído directamente.

**Migración.** `drizzle/migrations/0010_oauth_identities.sql` está escrita a mano, como las 0001 a 0008: `drizzle-kit generate` produciría una migración sin el backfill ni el `UPDATE`, y el snapshot de drizzle-kit quedó en la 0000 (ver `tests/integration/db/esquema-drizzle.test.ts`). `drizzle/schema.ts` y el snapshot de ese test sí se actualizaron. Es solo aditiva. Además de lo previsto normaliza `users.email` (`lower(trim(email))`) y crea el índice único `users_email_lower_idx`: si dos usuarios difieren solo en mayúsculas, el `UPDATE` o el índice fallan y la migración aborta sin crear nada (test incluido). Antes de desplegar hay que probarla con el export de producción, como pide el §10.

**Estado del intento de vincular en la cookie firmada, no en KV.** El §3.2 guardaba `{ codeVerifier, provider, intent, userId }` en KV; desde docs/20 el estado vive en la cookie firmada `oauth_state_<provider>`, así que `intent: "link"` y `userId` van ahí (`oauth-state.ts`). Un `intent` desconocido o un `link` sin `userId` se trata como login. Se extrajo `iniciarAutorizacion` (`src/lib/auth/iniciar.ts`) para compartir la construcción entre login y vincular. `POST /api/auth/vincular/[provider]` responde con redirect 303.

**Sesiones en D1 (docs/21).** El middleware sigue cargando solo `users`; no carga identidades (`§7`, fila de `middleware.ts`, no se hizo): Configuración consulta `oauth_identities` directamente y solo lee `provider`, nunca tokens.

**Códigos de error nuevos.** Se agregó `proveedor_en_uso` (el usuario ya tiene otra cuenta del mismo proveedor vinculada; el índice `UNIQUE (user_id, provider)` lo impone). Los errores de conflicto llevan `&proveedor=<google|microsoft>` (`/login?error=email_en_uso&proveedor=google`) y solo se reflejan si el valor es un proveedor conocido (`src/lib/auth/mensajes.ts`). Los de vinculación vuelven a `/configuracion`; `vinculo_sesion` sin sesión va a `/login`. Si un login automático se toparía con el índice por proveedor (la cuenta ya tiene otra identidad del mismo proveedor), se responde `email_en_uso`.

**V-17 (pre-secuestro): decisión abierta (3) resuelta fallando cerrado.** No se renombra el email de la cuenta no verificada (`@sin-verificar.invalid`). Hacerlo contradice V-04 (no se puede distinguir a un usuario Microsoft legítimo, que hoy son todos `email_verified = 0`, de un atacante) y deja huérfanos. Resultado: la dueña real recibe `email_en_uso` y no hereda ninguna cuenta ajena (el test V-17 verifica eso), pero no puede registrarse con ese email hasta que se resuelva a mano. Si el dueño decide la liberación automática, es una feature aparte.

**Decisiones abiertas del §11, resueltas por la opción segura.** (1) Auto-vincular con ambos lados verificados (D3.1): **apagado por defecto** tras la revisión; se prende con la variable `AUTO_VINCULAR_EMAIL_VERIFICADO=true` (opcional, sin definir = apagado; ver "Correcciones de la revisión"). (2) El mensaje de `email_en_uso` es genérico (ver "Correcciones de la revisión"). (4) **No se puede cambiar el calendario activo** en este release (no objetivo del §2): no existe el `PATCH` del paso 7. Consecuencia: la identidad activa nunca se puede desvincular (`identidad_activa`, 409), no solo "sin reemplazo".

**Actualización de datos del login.** Un reingreso actualiza tokens, `email`, `email_verified`, `tenant_id` y `last_login_at` de la identidad; `users.*` (tokens, nombre e imagen) solo si esa identidad es la del proveedor activo. Si el proveedor no reenvía el refresh token se conserva el anterior (D10).

**Chequeos de consistencia.** Se agregaron `user_without_identity` y `provider_without_identity` (severidad `warn`). No se agregó el de identidades huérfanas: la FK con `ON DELETE CASCADE` lo hace imposible en D1 y no se puede sembrar para probarlo.

**Borrado de cuenta (V-22).** `DELETE /api/cuenta` lee los accesos de todas las identidades antes del `DELETE FROM users` y revoca cada uno después; sin identidades usa `users.refresh_token` (usuario legado).

**No hecho.** El release N+1 (paso 10: eliminar fallback, doble escritura y columnas viejas). Tampoco se agregó el test E2E de Playwright de la pantalla `email_en_uso` y de Configuración con identidades sembradas (ese E2E no tiene sesión sembrada); la lógica de mensajes está cubierta por tests unitarios (`mensajes.test.ts`) y la de vinculación por integración. `npm run test:e2e` no se corrió en esta implementación.

**Tests.** `tests/integration/auth/vinculacion.test.ts` (V-01 a V-17 y V-20, más vincular), `vincular.test.ts`, `tests/integration/api/identidades.test.ts` (V-21), `tests/integration/migracion-identidades.test.ts` (V-18 y V-19), `tests/unit/auth/identity.test.ts`, `mensajes.test.ts`, ampliaciones en `callback.test.ts`, `tokens.test.ts`, `oauth-state.test.ts`, `cuenta.test.ts` y `consistency.test.ts`. El callback existente se reescribió: los tests que fijaban el comportamiento vulnerable (reingreso por email, y el orden mail/UPN como identidad) pasaron a probar identidad por `(provider, provider_id)` y el mail solo como email de contacto. Variables de entorno nuevas: `AUTO_VINCULAR_EMAIL_VERIFICADO` (opcional, apagada por defecto).

### Correcciones de la revisión (2026-11-03)

- **oid de cuentas personales (bloqueante).** En cuentas personales (MSA) Graph `/me.id` es el CID de 16 hex y el `oid` del ID token v2 es `00000000-0000-0000-<CID partido>`: la comparación estricta rechazaba todo login con Outlook o Hotmail, también el de usuarios existentes. `oidCoincide` (`identity.ts`) compara sin guiones y en minúsculas, quitando el prefijo `00000000-0000-0000-` solo si está; en cuentas de trabajo `id == oid`. Un mismatch real sigue fallando. Tests con ambos formatos y un mismatch. El formato MSA se tomó del reporte de la revisión, no de una cuenta real (el spike sigue pendiente): confirmarlo en el spike. `provider_id` se guarda siempre con el `id` de Graph, el mismo valor que ya tenían los usuarios existentes.
- **Pre-chequeo de colisiones de email.** La migración 0010 aborta si dos usuarios difieren solo en mayúsculas o espacios, y eso traba `deploy.yml` y `staging.yml`. Paso obligatorio antes del PR de release (y antes de mergear a `development`, que despliega staging): `scripts/check-email-collisions.mjs` (`npm run db:check-emails`) o el comando manual, más el procedimiento de fusión, en `docs/23` §6. El test de migración solo prueba que la migración falla con colisiones, no la atomicidad de wrangler.
- **Pre-secuestro (V-17).** Procedimiento de soporte para quien recibe `email_en_uso` en `docs/23` §6 (verificar el buzón, mirar la cuenta bloqueadora, liberar el email solo si no está verificado y sin actividad).
- **`email_en_uso` genérico.** Se revertió la decisión (2) del §11: el mensaje y la URL ya no nombran el proveedor de la otra cuenta (`/login?error=email_en_uso`), porque confirmaba que el email estaba registrado y con qué proveedor. El texto invita a entrar con el proveedor con el que se creó la cuenta y vincular desde Configuración. El resto de los códigos solo reflejan el proveedor del intento actual.
- **Auto-vínculo D3.1 detrás de un flag, apagado por defecto** (§11 lo pedía). Con el flag apagado, "ambos lados verificados" también da `email_en_uso`. Hoy solo Google puede estar verificado, así que prenderlo solo tendría efecto en casos como una cuenta verificada vía otro proveedor; se decide al cerrar el spike de `xms_edov`.
- **Riesgo de despliegue: Escenario C heredado.** El backfill copia `users.*` tal cual: un usuario que ya tenía los tokens de un proveedor pisados por el otro (§1.2, Escenario C) conserva tokens que no sirven en `oauth_identities`. No se agregó chequeo de consistencia: detectarlo solo se puede por heurística sobre el formato del token (`ya29.` de Google), que deja de valer con el cifrado del TDD 15 y daría falsos positivos permanentes. Se documentó la consulta de verificación pre-release en `docs/23` §6; la persona afectada se recupera reingresando.

## Fuentes

- Microsoft Learn, "ID token claims reference": https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference
- Google, "OpenID Connect": https://developers.google.com/identity/openid-connect/openid-connect
- nOAuth y `xms_edov` (fuentes secundarias, a contrastar en el spike): https://www.descope.com/blog/post/noauth, https://clerk.com/docs/guides/configure/auth-strategies/social-connections/microsoft, https://docs.prelude.so/auth/documentation/integration-guide/social-login/microsoft
