# TDD: Cifrado de tokens OAuth en reposo

> Technical Design Document. Estado: **propuesto, pendiente de revisión**. Fecha: 2026-10-22. Rama de implementación: `feat/cifrado-de-tokens`, desde `development` **después** de mergear `feat/borrado-de-cuenta` (ver §6).
>
> Este documento registra **qué problema hay hoy, qué decidimos y por qué**. El código y los tests se escriben después de que se apruebe, siguiendo el orden del §6.

## 1. Contexto y problema

`users.access_token` y `users.refresh_token` se guardan **en texto plano** en D1 (`drizzle/schema.ts`, escritos en `api/auth/callback/[provider].ts` y `lib/auth/tokens.ts`). El refresh token da acceso de escritura al calendario del usuario **sin vencimiento** hasta que lo revoque.

Quién podría leerlos hoy: cualquiera con acceso a la base (`wrangler d1 execute`, el dashboard, una exportación, un backup, un volcado de Time Travel, una consulta SQL mal protegida o un log mal hecho). Con muchos usuarios, una filtración de la base serían credenciales utilizables contra sus calendarios.

Google lo revisa en la verificación de apps con scopes sensibles, y es una práctica mínima esperable.

### 1.1 Dónde se tocan los tokens

| Archivo | Uso |
| --- | --- |
| `src/pages/api/auth/callback/[provider].ts` | Guarda `accessToken`, `refreshToken`, `tokenExpiresAt` al iniciar sesión (alta y reingreso) |
| `src/lib/auth/tokens.ts` (`getValidAccessToken`) | Lee el access token, lo renueva con el refresh token y guarda el nuevo |
| `src/lib/calendar/google.ts`, `microsoft.ts` | Reciben el token como `string` (no lo leen de la base) |
| `src/middleware.ts` | Carga la fila completa del usuario en `locals.user` (incluye los tokens) |
| `src/lib/observability/logger.ts` | Ya enmascara claves que contengan `token` |
| `docs/14-borrado-de-cuenta-tdd.md` | La revocación al borrar la cuenta lee el refresh token |

## 2. Objetivos y no objetivos

**Objetivos**

1. Ningún token OAuth queda en texto plano en D1 (ni en backups o exportaciones).
2. Una base filtrada **sin** la clave no sirve para obtener credenciales.
3. La clave se puede **rotar** sin que los usuarios tengan que volver a iniciar sesión.
4. Migración de los usuarios existentes sin cortar el servicio.
5. Si falta la clave, el sistema **falla cerrado**: nunca guarda un token en claro como alternativa.
6. Cada caso del §4 tiene un test automático escrito **antes** de la implementación.

**No objetivos**

- Proteger contra alguien con control del Worker en ejecución o con acceso a los secrets (puede descifrar igual; es el límite de cualquier esquema con clave en el servidor).
- Cifrar el resto de los datos personales (email, nombre).
- Un servicio de claves externo (KMS) o cifrado de sobre con claves por usuario (ver D2).
- Cambiar los scopes pedidos ni la forma en que funciona el login.

## 3. Diseño

### 3.1 Formato del valor guardado

```
enc:v1:<iv>:<ciphertext+tag>        (iv y ciphertext en base64url)
```

- Algoritmo: **AES-256-GCM** con WebCrypto (`crypto.subtle`), disponible en Workers. Sin dependencias nuevas.
- IV de 12 bytes aleatorios por cada cifrado (`crypto.getRandomValues`): el mismo token cifrado dos veces da textos distintos.
- **Datos autenticados asociados (AAD):** `<userId>:<columna>` (`access_token` o `refresh_token`). Atan el texto cifrado a su fila y columna: copiar el valor de un usuario a otro, o el access al lugar del refresh, falla al descifrar.
- El prefijo `enc:v1:` permite distinguir valores cifrados de los viejos en claro y versionar el formato.

### 3.2 Decisiones

**D1. AES-GCM con una clave maestra en un secret.**
`TOKEN_ENCRYPTION_KEY`: 32 bytes aleatorios en base64, como secret de Cloudflare Pages (nunca en `wrangler.toml` ni en el repo). Protege la base por separado de la clave: hay que comprometer ambas.
*Alternativas descartadas:* cifrar con `ADMIN_SECRET` (mezcla propósitos y se rota por otras razones); usar solo el cifrado en reposo de Cloudflare (protege el disco, no una exportación ni una consulta con credenciales válidas).

**D2. Una clave maestra, no una por usuario.**
Claves por usuario o cifrado de sobre exigen un lugar donde guardar esas claves y un KMS; para esta escala no suma protección real frente al modelo de amenaza del §2. Queda abierto a futuro (el prefijo `v1` permite un `v2`).

**D3. Rotación con dos claves: actual y anterior.**
`TOKEN_ENCRYPTION_KEY` (cifra siempre) y `TOKEN_ENCRYPTION_KEY_PREVIOUS` (opcional, solo descifra). Descifrar prueba primero la actual y después la anterior; si lo logró con la anterior, el valor se **vuelve a cifrar con la actual** la próxima vez que se escriba el token. Un endpoint de mantenimiento (D5) permite re-cifrar todo en bloque antes de retirar la clave vieja.
Para saber con cuál clave se cifró sin probar, no se guarda un identificador: con dos claves como máximo, probar es barato y evita otro dato que mantener.

**D4. Falla cerrada.**
Si falta `TOKEN_ENCRYPTION_KEY` o no tiene 32 bytes, escribir tokens **lanza un error** (en el login responde `/login?error=oauth_failed` y se loguea `token_key_missing`). **Nunca** se cae a texto plano. Leer un valor cifrado sin clave también falla (se trata como "sin permiso de calendario": el usuario reconecta).
El check de `/api/health` agrega `tokenKey`: `fail` si el secret falta o es inválido, para detectarlo antes de que un usuario lo sufra.

**D5. Migración de lo existente: lectura dual + backfill idempotente.**
Una migración SQL no puede cifrar (la clave no está en la base), así que se hace por código en tres fases:

1. **Release A.** El código **lee** ambos formatos (con prefijo `enc:v1:` descifra; sin prefijo lo toma como legado en claro) y **escribe siempre cifrado**. Cada login y cada renovación de token ya cifra a ese usuario.
2. **Backfill.** `POST /api/admin/encrypt-tokens` (Bearer `ADMIN_SECRET`, como el resto de `/api/admin`): recorre en lotes las filas con valores sin prefijo (o cifrados con la clave anterior) y los re-cifra. Es **idempotente** y se puede repetir hasta que devuelva `pendientes: 0`. Cada corrida se loguea como `token_backfill` con conteos, sin tokens.
3. **Release B.** Cuando `pendientes` es 0 en producción, un cambio chico elimina la lectura de texto plano: un valor sin prefijo pasa a ser error.

El chequeo de consistencia existente (`lib/observability/consistency.ts`) suma un conteo de tokens sin cifrar, visible en `/api/admin/status`.

**D6. Un solo módulo para tocar tokens.**
`src/lib/auth/token-crypto.ts` (`encryptToken`, `decryptToken`, que reciben el `Env`, el valor y el contexto AAD) y `src/lib/auth/token-store.ts` (`saveTokens(db, env, userId, tokens)` y `readTokens(env, user)`). El callback, `getValidAccessToken` y la revocación del borrado de cuenta dejan de leer o escribir las columnas directamente. Se evita así que un camino nuevo guarde un token en claro por olvido.

**D7. Los tokens no viajan más de lo necesario.**
El middleware carga la fila completa en `locals.user`. Se deja igual (cambiarlo toca todas las páginas), pero como el valor ahora es texto cifrado, un descuido de logueo o de serialización ya no expone un token usable. Descifrar ocurre solo en `readTokens`, justo antes de llamar a la API del proveedor.

**D8. Costo.**
AES-GCM sobre unos cientos de bytes es despreciable frente a una llamada HTTP al proveedor. Importar la clave (`crypto.subtle.importKey`) se cachea por clave dentro del isolate.

## 4. Casos a cubrir

| ID | Caso | Comportamiento esperado |
| --- | --- | --- |
| K1 | Cifrar y descifrar | Se recupera el token original |
| K2 | Cifrar el mismo token dos veces | Textos distintos (IV aleatorio) |
| K3 | Alterar un byte del texto cifrado | Descifrar falla (autenticación GCM) |
| K4 | Descifrar con otro `userId` o columna (AAD) | Falla |
| K5 | Descifrar con una clave incorrecta | Falla |
| K6 | Valor cifrado con la clave anterior | Se descifra con `..._PREVIOUS` |
| K7 | Falta `TOKEN_ENCRYPTION_KEY` o es inválida | Escribir lanza; **no** se guarda nada en claro |
| K8 | Login nuevo | Las columnas quedan con prefijo `enc:v1:` |
| K9 | Reingreso de usuario existente | Se re-cifran con la clave actual |
| K10 | `getValidAccessToken` con token vigente | Descifra y devuelve el access token |
| K11 | `getValidAccessToken` con token vencido | Renueva, guarda **cifrado** y devuelve el nuevo en claro |
| K12 | Fila legada en claro (sin prefijo), antes del Release B | Se lee bien; al renovar o en el backfill pasa a cifrada |
| K13 | Backfill | Cifra las filas legadas y las de la clave anterior; segunda corrida: `pendientes: 0` y no cambia nada |
| K14 | Backfill sin Bearer o con uno incorrecto | `401`, no toca la base |
| K15 | Logs de login, renovación y backfill | No contienen ningún token, ni en claro ni cifrado |
| K16 | `/api/health` sin clave | `fail` en `tokenKey` |
| K17 | Borrado de cuenta (TDD 14) con token cifrado | La revocación recibe el token descifrado |
| K18 | Release B: valor sin prefijo | Error tratado como "reconectar" |

## 5. Estrategia de tests (test primero)

Rojo, verde, refactor. Los tests inyectan una clave fija de prueba en el `Env` (el CI de `test-suite.yml` no necesita secrets reales).

| Archivo | Cubre |
| --- | --- |
| `tests/unit/auth/token-crypto.test.ts` | K1 a K7: cifrado, IV, alteración, AAD, clave incorrecta, rotación, falla cerrada |
| `tests/integration/tokens.test.ts` (extiende el actual) | K10 a K12: lectura vigente, renovación guardada cifrada, fila legada |
| `tests/integration/auth/` (extiende) | K8, K9: el callback guarda cifrado |
| `tests/integration/api/encrypt-tokens.test.ts` | K13, K14: backfill idempotente y autenticado |
| `tests/observability/` (extiende) | K15, K16: sin tokens en logs; check de salud |
| `tests/integration/api/cuenta.test.ts` (extiende) | K17: borrado de cuenta con token cifrado |

## 6. Plan de implementación

**Orden:** primero se mergea el borrado de cuenta (TDD 14), que **no** depende del cifrado. Después este cambio ajusta la revocación para descifrar (K17).

1. Tests de `token-crypto` en rojo (K1 a K7). Implementar `token-crypto.ts`. Verde.
2. `token-store.ts` y migrar `getValidAccessToken` y el callback a usarlo (K8 a K12).
3. Ajustar la revocación del borrado de cuenta (K17).
4. Endpoint de backfill y conteo de pendientes en `consistency.ts` y `/api/admin/status` (K13, K14).
5. Check `tokenKey` en `/api/health` (K16) y tests de logs (K15).
6. Documentación: `env.d.ts`, `.env.example`, `docs/03-autenticacion.md`, `docs/08-deploy-infraestructura.md` (secret y procedimiento de rotación). Notas de implementación (§9).
7. **Release B** (PR aparte, solo cuando producción tenga `pendientes: 0`): eliminar la lectura de texto plano (K18).

## 7. Despliegue y rollback

**Antes de mergear a `main` (obligatorio):**

1. Generar la clave: `openssl rand -base64 32`.
2. Cargarla como secret de producción: `npx wrangler pages secret put TOKEN_ENCRYPTION_KEY --project-name fisture`.
3. Guardarla en un gestor de contraseñas (si se pierde, no hay forma de recuperar los tokens: los usuarios tendrían que reconectar su calendario, pero no se pierde ningún otro dato).
4. Con el secret cargado, `/api/health` debe mostrar `tokenKey: ok` antes de dar por bueno el deploy.

**Orden de despliegue:** Release A → backfill → verificar `pendientes: 0` → (días después) Release B.

**Rollback:**
- El código anterior no entiende el prefijo `enc:v1:`: usaría el valor cifrado como si fuera el token y el proveedor respondería 401. Revertir el Release A deja afectados a los usuarios cuyos tokens ya se cifraron (los que iniciaron sesión o renovaron después del deploy, y todos si ya se corrió el backfill). Esos usuarios tienen que volver a iniciar sesión; el flujo ya clasifica el caso como `auth` y la UI pide reconectar, así que es un costo acotado y visible, sin pérdida de datos.
- Para evitarlo, el endpoint de backfill acepta `?direction=decrypt`, que devuelve las filas a texto plano en bloque. Solo funciona con `ADMIN_SECRET` y con la clave presente, y existe únicamente para este rollback: se corre **antes** de revertir el código.

**Rotación de clave (procedimiento):** mover la actual a `TOKEN_ENCRYPTION_KEY_PREVIOUS`, cargar una nueva en `TOKEN_ENCRYPTION_KEY`, correr el backfill hasta `pendientes: 0` y recién entonces borrar la `PREVIOUS`.

## 8. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Se pierde la clave | Gestor de contraseñas; el impacto es "reconectar calendario", no pérdida de datos |
| Falta el secret en producción tras el deploy | Falla cerrada (D4) y check de salud (K16) antes de dar por bueno el release |
| Un camino nuevo guarda tokens en claro | Un solo módulo (D6) y un test que verifica que ninguna columna queda sin prefijo tras cada flujo |
| El backfill excede los límites de una invocación | Procesa por lotes con tope; se repite hasta `pendientes: 0` |
| Mezcla de formatos durante la transición | Lectura dual explícita (D5) y conteo visible de pendientes |
| Falsa sensación de seguridad | El §2 aclara el alcance: protege la base, no un Worker comprometido |

## 9. Notas de implementación

_(Se completa al terminar: desvíos respecto del diseño, decisiones tomadas en el camino.)_

## 10. Fuera de alcance (fases siguientes)

- Claves por usuario o cifrado de sobre con KMS (formato `v2`).
- Cifrar otros datos personales.
- No persistir el access token (obtener uno nuevo en cada sync a partir del refresh token) para reducir lo que se guarda.
