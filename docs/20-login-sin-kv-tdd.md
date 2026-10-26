# TDD: Login sin escrituras en KV

> Technical Design Document. Estado: **propuesto, pendiente de revisión**. Fecha: 2026-10-26. Rama de implementación: `fix/login-sin-kv`, desde `development` (o desde `main` si se trata como hotfix, ver §8).
>
> Este documento registra **qué problema hay hoy, qué decidimos y por qué**. El código y los tests se escriben después de que se apruebe, siguiendo el orden del §7. Complementa a `docs/16-rate-limiting-y-origen-tdd.md` (R3), que reduce el abuso del login pero no elimina su costo en KV.

## 1. Contexto y problema

El 2026-10-26 (~14:00 UTC) el inicio de sesión de producción respondía **500** con Google y con Microsoft. Los logs del deployment (`wrangler pages deployment tail`) muestran la causa:

```
GET /api/auth/login/google -> 500
err.message: "KV put() limit exceeded for the day."
    at pages/api/auth/login/_provider_.astro.mjs:16:16
```

El plan Workers Free permite **1.000 escrituras de KV por día** (es el dato que usa `docs/16` §3, O3). Se agotaron antes de las 11:00 hora de Argentina, con muy pocos usuarios reales.

### 1.1 Por qué se agota tan rápido

Fisture escribe en KV en dos lugares (`grep` de `KV.put` en `src/`):

| Dónde | Cuándo | Cuántas escrituras |
| --- | --- | --- |
| `src/pages/api/auth/login/[provider].ts` | **Cada `GET /api/auth/login/*`**, antes de redirigir al proveedor | 1 por request, **sin sesión, sin límite y sin ninguna identidad** |
| `src/lib/auth/session.ts` (`createSession`) | Solo al completar un login real | 1 por login exitoso |

El primero es la fuga: cualquier cliente que haga `GET /api/auth/login/google` (un bot, un crawler que sigue el enlace del botón de `/login`, un escáner de vulnerabilidades, o un humano que recarga) gasta una escritura. Con mil requests se agota el día para **todos**, y el login queda caído hasta las 00:00 UTC. Es además una superficie de denegación de servicio trivial.

**Hipótesis, no confirmada:** el tráfico es automático. Los datos del tail en vivo no lo prueban (en ese momento solo se veían los requests de la propia verificación). Se confirma en el paso 0 del §7, mirando Analytics de la zona `fisture.com`, filtrando por la ruta `/api/auth/login`. El diseño de abajo es correcto aunque la hipótesis resulte falsa: elimina la escritura por request.

### 1.2 Impacto

- Nadie puede iniciar sesión mientras el contador esté agotado. Los usuarios con sesión vigente siguen entrando (leer KV es otro límite, de 100.000 por día).
- La verificación de Google exige que el login funcione cuando el revisor lo pruebe.
- El mismo límite alcanza a las sesiones nuevas: un abuso del login impide también logins legítimos.

## 2. Objetivos y no objetivos

**Objetivos**

1. `GET /api/auth/login/*` **no escribe en KV**, sin importar cuántas veces se llame.
2. El login legítimo sigue funcionando igual para el usuario: mismo flujo, mismas pantallas, mismo `next`.
3. Se conserva la protección actual del flujo: `state` anti-CSRF, PKCE (`code_verifier`) y `next` validado por `safeNext`.
4. El callback sigue consumiendo el intento una sola vez desde el punto de vista del proveedor (el `code` de OAuth es de un solo uso).
5. Un abuso del endpoint de login ya no puede agotar un recurso compartido que afecte al resto de los usuarios.
6. Todo cubierto por tests, incluido uno de regresión que cuenta las escrituras en KV.

**No objetivos**

- Mover las sesiones fuera de KV (1 escritura por login completado: queda como está, con su costo acotado, ver §9).
- Implementar el rate limiting de `docs/16`: es complementario y se hace aparte.
- Cambiar los proveedores, los scopes ni la forma de crear la sesión.
- Resolver el plan de Cloudflare (ver D6).

## 3. Decisiones

**D1. El estado del login viaja en una cookie firmada, no en KV.**
En `login` se genera `state` y `codeVerifier` como hoy y se arma un payload `{ state, codeVerifier, provider, next, exp }`. Se guarda en la cookie `oauth_state` con el formato `base64url(payload) + "." + base64url(HMAC-SHA256(payload))`. Atributos: `HttpOnly`, `Secure` en producción, `SameSite=Lax`, `Path=/api/auth`, `Max-Age=600` (los mismos 10 minutos que hoy tiene el registro en KV).

Por qué funciona con OAuth: el proveedor redirige de vuelta con un `GET` de navegación de nivel superior, y `SameSite=Lax` envía la cookie en ese caso. La cookie liga el intento al **navegador que lo inició**, que es justo lo que el registro en KV no hacía (en KV cualquiera con el `state` podía consumirlo).

**D2. El callback valida la cookie y no toca KV para el estado.**
Orden de validación: la cookie existe → la firma es válida (comparación en tiempo constante) → no expiró (`exp`) → `state` de la URL es igual al de la cookie → `provider` de la ruta es igual al de la cookie. Cualquier fallo redirige a `/login?error=invalid_state`, como hoy. Después se borra la cookie, tenga éxito o no el intercambio. Se evita así que un estado se reutilice desde el mismo navegador; además el `code` es de un solo uso en el proveedor (ver riesgo R1).

Mejora de paso: hoy el callback no comprueba que el `provider` guardado coincida con el de la ruta; con D2 sí.

**D3. Firma con un secret nuevo: `OAUTH_STATE_SECRET`.**
32 bytes aleatorios, cargado como secret de Pages. Se usa HMAC-SHA256 de WebCrypto (disponible en Workers, sin dependencias). Falla cerrada: sin el secret el login responde un error controlado y se registra `oauth_state_secret_missing`, sin escribir nada. El chequeo se suma a `/api/health` (como `tokenKey` en `docs/15`) para detectar el secret faltante antes de que lo note un usuario.
**Rotación:** como la cookie vive 10 minutos, rotar es reemplazar el secret; los logins en curso fallan una vez y se reintentan. No hace falta clave anterior.

**D4. El payload no es secreto frente al usuario, y no hace falta que lo sea.**
El `codeVerifier` queda en una cookie `HttpOnly` de ese mismo navegador: ni el JavaScript de la página ni terceros pueden leerlo, y nadie más recibe esa cookie. PKCE protege contra la intercepción del `code` en la redirección, no contra el dueño del navegador. Se firma para que no se pueda **alterar**; no se cifra.

**D5. Mitigaciones inmediatas sin código, en el panel de Cloudflare.** Complementan, no reemplazan, a D1:
- Activar **Bot Fight Mode** (Security → Bots, disponible en Free).
- Una regla personalizada de WAF con acción *Managed Challenge* sobre `http.request.uri.path contains "/api/auth/login"` y `not http.referer contains "fisture.com"`. Un login legítimo parte del botón de `/login` y trae el Referer del propio sitio. Es el punto D3 de `docs/16`, ahora posible porque el dominio ya está en Cloudflare.
- Agregar `rel="nofollow"` a los enlaces de login para que los crawlers que respetan HTML no los sigan.

**D6. Pasar a Workers Paid es una decisión operativa independiente.**
Sube los límites de KV y de D1 y extiende Time Travel a 30 días (hay que actualizar el texto de privacidad, ver `docs/14`). Destapa el síntoma de hoy, pero no corrige que un request anónimo cueste una escritura. Se puede hacer antes, después o nunca de este cambio; este TDD funciona en Free.

**Alternativas descartadas**

| Alternativa | Por qué no |
| --- | --- |
| Solo subir de plan | El abuso sigue gastando cuota y dinero; un bot puede igual agotar el límite mayor |
| Solo rate limiting por IP en D1 (`docs/16`) | Cada intento permitido (hasta 10 por IP cada 10 min) sigue escribiendo en KV y en D1; con IPs distintas se agota igual |
| Cookie cifrada con AES-GCM (como `docs/15`) | Acopla este arreglo a la rama del cifrado de tokens sin necesidad: D4 muestra que no hace falta confidencialidad |
| Durable Object para el estado | Agrega un binding, otro runtime y costo para algo que una cookie resuelve |
| Memoria del Worker | Cada request puede caer en otra instancia: el callback no encontraría el estado |
| Turnstile en el login | Útil si hay registro masivo; agrega fricción al usuario. Queda como siguiente paso (`docs/16`, fuera de alcance) |

## 4. Diseño

```
GET /api/auth/login/google
  1. secret presente? si no -> error controlado, log, sin side effects
  2. state, codeVerifier = random
  3. payload = { state, codeVerifier, provider, next: safeNext(?next), exp: ahora + 600 s }
  4. Set-Cookie oauth_state = firmar(payload)        <- sin KV
  5. 302 al proveedor (con state y code_challenge)

GET /api/auth/callback/google?code=..&state=..
  1. cookie oauth_state -> verificar firma, exp, state, provider
  2. borrar la cookie
  3. intercambiar el code (con el codeVerifier del payload)
  4. crear/actualizar usuario y sesión (1 put en KV, solo aquí)
```

Módulo nuevo `src/lib/auth/oauth-state.ts` con `crearEstado(env, datos)` y `leerEstado(env, cookie, esperado)`, aislado para probarlo sin HTTP. Los handlers solo orquestan.

## 5. Estrategia de tests (test primero: rojo, verde, refactor)

| ID | Caso | Resultado esperado |
| --- | --- | --- |
| L1 | `GET /login/google` | Responde 302, **no llama a `KV.put`**, setea `oauth_state` con `HttpOnly`, `SameSite=Lax`, `Path=/api/auth`, `Max-Age=600` |
| L2 | `state` y `code_challenge` de la URL de redirección | El `state` coincide con el del payload de la cookie; el challenge corresponde al verifier |
| L3 | **Regresión de abuso:** 100 llamadas seguidas al login | 0 escrituras en KV |
| L4 | Callback con cookie válida | Crea la sesión (única escritura en KV), no lee `oauth:*`, borra la cookie |
| L5 | Callback sin cookie | `/login?error=invalid_state`, sin intercambiar el code |
| L6 | Cookie con la firma alterada o el payload modificado | `invalid_state` |
| L7 | Cookie expirada (`exp` pasado, con reloj fijo) | `invalid_state` |
| L8 | `state` de la URL distinto del de la cookie | `invalid_state` |
| L9 | Cookie emitida para `google` usada en `/callback/microsoft` | `invalid_state` |
| L10 | Sin `OAUTH_STATE_SECRET` | Login: error controlado y 0 escrituras; `/api/health` lo informa |
| L11 | `next` externo (`//evil.com`) en el login | Se descarta por `safeNext`, como hoy |
| L12 | Los logs de login y callback | Sin `state`, `codeVerifier`, cookie ni `next` completo |
| L13 | E2E (Playwright) de login con el servidor local y proveedor simulado | Flujo completo: login → callback → sesión |

**Tests existentes a actualizar** porque hoy suponen el estado en KV: `tests/unit/auth/login.test.ts` (líneas del `put` con `oauth:`), `tests/integration/auth/callback.test.ts` (`seed` de `oauth:<state>`), `tests/integration/api/cuenta.test.ts` (el `kv.put("oauth:st", ...)` del caso C10) y el seed de `scripts/e2e-server.mjs` si lo usa. Es un cambio de forma de la precondición, no de lo que se verifica.

Verde: la suite completa (`npm run check`). Refactor: borrar los restos de `oauth:` y el TTL de 600 s de KV, y reutilizar la constante en cookie y payload.

## 6. Despliegue y rollback

**Antes del deploy:** crear el secret en Pages: `openssl rand -base64 32 | npx wrangler pages secret put OAUTH_STATE_SECRET --project-name fisture`, y verificar que figure con `wrangler pages secret list`. Sin secret el login falla cerrado: un deploy sin él es peor que no desplegar.

- **Sin migraciones de D1** y sin bindings nuevos.
- Los logins iniciados con el código viejo (estado en KV) y terminados con el nuevo fallan una vez con `invalid_state`: la ventana es de 10 minutos y el usuario reintenta. No hay pérdida de datos.
- **Rollback:** volver al deployment anterior. El código viejo ignora la cookie `oauth_state` y vuelve a usar KV. Mismo costo transitorio de 10 minutos.
- **Verificación posterior:** `GET /api/health` (con el check nuevo en `ok`), un login real con Google y con Microsoft, y comprobar en el dashboard de KV que las escrituras ya no crecen con cada visita al login.

## 7. Plan de implementación

0. **Medir.** Antes de tocar código: Analytics de la zona, tráfico a `/api/auth/login` en las últimas 24 h, por país y por user agent. Anotar el resultado en el §10. Si el tráfico es chico y legítimo, el diseño sigue siendo válido pero hay que buscar otra fuente de escrituras (p. ej. sesiones) antes de culpar al login.
1. Tests en rojo: `oauth-state` unitarios (L5 a L9 sobre el módulo), L1 a L4 y L10 a L12 sobre los handlers.
2. `oauth-state.ts` (firma, verificación, expiración, tiempo constante). Verde de los unitarios.
3. `login/[provider].ts`: cookie en lugar de `KV.put`. Verde de L1 a L3, L10 y L11.
4. `callback/[provider].ts`: lectura de la cookie en lugar de `KV.get`/`KV.delete`. Verde de L4 a L9.
5. Check `oauthState` en `/api/health` y en `consistency`/`status` si corresponde (L10).
6. Actualizar los tests existentes del §5 y agregar L13.
7. `rel="nofollow"` en los enlaces de login; documentar el secret en `docs/03-autenticacion.md` y `docs/08-deploy-infraestructura.md`.
8. Reglas de Cloudflare de D5 (a mano) y registro en el §10.

## 8. Urgencia y hotfix

El login sigue caído mientras el contador del día esté agotado y se repite cada día. Opciones sin esperar a la implementación: D5 (reglas de Cloudflare, en minutos) y/o D6 (Workers Paid). Si el cambio de código se aprueba pronto, se trata como `fix/*` desde `main` con PR a `main` y luego PR de `main` a `development`, según el flujo de ramas del `CLAUDE.md`.

## 9. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| **R1. Reutilización del estado:** sin KV no se puede invalidar del lado servidor, así que la misma cookie sirve durante 10 minutos | El `code` de OAuth es de un solo uso en Google y Microsoft (un segundo intercambio falla); el callback borra la cookie en el primer uso; la cookie está ligada al navegador (`HttpOnly`) |
| **R2. Secret filtrado:** permitiría forjar un estado válido (login CSRF) | Es un secret de Pages como `ADMIN_SECRET`; rotarlo es inmediato y su efecto es solo reintentar el login; no abre acceso a cuentas |
| **R3. Cookies bloqueadas en el navegador** | Ya hace falta la cookie de sesión para usar la app; la cookie es de primer nivel y del mismo sitio, no afectada por bloqueo de terceros |
| **R4. Las sesiones siguen usando 1 escritura por login completado** | Acotado por un login OAuth real con el proveedor. Con unos pocos cientos de logins por día alcanza en Free; si crece, Workers Paid (D6) o sesiones firmadas en cookie (fuera de alcance) |
| **R5. Tamaño de la cookie** | El payload mide cientos de bytes, muy por debajo del límite de 4 KB; hay un test que lo fija |
| **R6. Se asume que el tráfico es de bots y no lo es** | Paso 0 del §7: se mide antes de implementar |

## 10. Notas de implementación (desvíos respecto del diseño original)

*(Vacía hasta que se apruebe el TDD y empiece la implementación. Aquí van el resultado del paso 0 y los desvíos.)*
