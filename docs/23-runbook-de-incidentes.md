# Runbook de incidentes y rollback

Qué hacer cuando algo se rompe en producción (`https://fisture.com`). Cada paso dice cómo verificar que funcionó.
Proyecto de Pages: `fisture`. Base D1: `fisture-db`. Los comandos de `wrangler` se corren desde la raíz del repo
con una sesión de `npx wrangler login` (o `CLOUDFLARE_API_TOKEN` en el entorno).

## 0. Primeros cinco minutos

1. `curl -s https://fisture.com/api/health` → `ok`, `degraded` o `fail` (503), con el detalle por chequeo
   (`db`, `kv`, `sync` para las ligas, `calendars` y `oauthState`).
2. Detalle del sync: `curl -s -H "Authorization: Bearer $ADMIN_SECRET" https://fisture.com/api/admin/status`
   (salud + últimos 20 runs con sus errores).
3. Logs en vivo: `npx wrangler pages deployment tail --project-name fisture` (JSON; filtrar por `requestId`
   si el usuario lo tiene del header `x-request-id`).
4. ¿Coincide con un deploy? Ver la última corrida de **Deploy a producción** en GitHub Actions.

Avisos automáticos: `monitor.yml` (cada 30 min), `sync-cron.yml` (ligas y calendarios) y `keepalive.yml`
(semanal) abren un issue con la etiqueta `incidente` y lo cierran al recuperarse. Comentar en ese issue lo que se va haciendo: queda como registro.

## 1. Volver al deployment anterior (rollback de código)

Cuándo: el problema empezó con un deploy y no hay un arreglo inmediato.

1. Cloudflare → Workers & Pages → `fisture` → **Deployments** → en el deployment anterior de producción,
   **⋯ → Rollback to this deployment**. Es instantáneo y no requiere build.
2. Verificar: `curl -s https://fisture.com/api/health` y la acción que fallaba.
3. El rollback **no revierte migraciones de D1** (ver §2). Todas las migraciones del proyecto son aditivas, así
   que el código anterior funciona con la base nueva salvo que el TDD de esa migración diga lo contrario
   (sección "Despliegue y rollback" de cada `docs/NN-*-tdd.md`).
4. Después: `fix/*` desde `main` → PR a `main` → PR de `main` a `development` (flujo de hotfix del `CLAUDE.md`).

## 2. Una migración de D1 falló a mitad

`deploy.yml` aplica las migraciones **antes** del deploy: si fallan, el deploy no ocurre y el código viejo sigue
sirviendo.

1. Ver qué quedó aplicado: `npx wrangler d1 migrations list fisture-db --remote`.
2. D1 aplica cada archivo en una transacción: una migración que falló no queda a medias. Corregir el SQL en un
   PR nuevo (no editar una migración ya aplicada en producción) y volver a desplegar.
3. Si una migración aplicada dejó datos mal: restaurar con Time Travel (§3) a un punto anterior al deploy.

## 3. Restaurar la base (Time Travel)

D1 guarda un historial continuo: **7 días en Workers Free** (30 en Paid). No hace falta activarlo.

```bash
# Bookmark del estado en un momento dado (RFC 3339 o timestamp UNIX)
npx wrangler d1 time-travel info fisture-db --timestamp=2026-11-03T12:00:00Z

# Restaurar (reemplaza la base entera; avisa y pide confirmación)
npx wrangler d1 time-travel restore fisture-db --timestamp=2026-11-03T12:00:00Z
```

- La restauración devuelve un bookmark "anterior a la restauración": guardarlo en el issue, permite deshacerla.
- Todo lo escrito después del punto elegido se pierde (logins, partidos agregados, **borrados de cuenta**). Si un
  usuario borró su cuenta en ese intervalo, volver a borrarla a mano después de restaurar (la política de
  privacidad promete el borrado).
- Probarlo primero sobre una base de staging: `npx wrangler d1 create fisture-staging`, cargarla con
  `npx wrangler d1 export fisture-db --remote --output=dump.sql` y
  `npx wrangler d1 execute fisture-staging --remote --file=dump.sql`, y ensayar `time-travel restore` ahí.
- Export manual (copia fuera de Cloudflare): `npx wrangler d1 export fisture-db --remote --output=backup.sql`.
  Tiene datos personales y tokens: guardarlo cifrado, borrarlo a los 7 días (mismo plazo que declara
  `/privacidad`) y no subirlo a ningún repo.

## 4. Disparar un sync manual

- GitHub → Actions → **Sync diario** → *Run workflow* (recorre todos los lotes, docs/22 D4).
- Una competencia: `curl -X POST https://fisture.com/api/admin/sync -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" -d '{"leagueId":"arg.1"}'`.
- Un lote: igual con `-d '{"lote":0}'`; la respuesta trae `siguienteLote`.
- Un lote de calendarios: `-d '{"calendarios":true}'`; la respuesta trae `corte` y `siguiente`. Para seguir el barrido
  se repite con `"corte": <el corte devuelto>` mientras `siguiente` sea `true`. Desde la terminal:
  `APP_URL=https://fisture.com ADMIN_SECRET=... node scripts/sync-calendarios.mjs` (docs/17).
- Sin `Content-Type: application/json` la protección CSRF de Astro responde 403.

## 5. Revocar y rotar un secret

| Secret | Dónde se rota | Efecto de rotarlo |
| --- | --- | --- |
| `ADMIN_SECRET` | `npx wrangler pages secret put ADMIN_SECRET --project-name fisture` **y** el secret del mismo nombre en GitHub Actions | Ninguno para usuarios. Sin actualizar GitHub, el sync diario falla con 401 |
| `OAUTH_STATE_SECRET` | `openssl rand -base64 32 \| npx wrangler pages secret put OAUTH_STATE_SECRET --project-name fisture` | Los logins en curso (10 min) fallan y hay que reintentar |
| `TOKEN_ENCRYPTION_KEY` | Rotación sin que nadie reconecte: (1) copiar la actual a `TOKEN_ENCRYPTION_KEY_PREVIOUS`, (2) cargar una nueva en `TOKEN_ENCRYPTION_KEY` (`openssl rand -base64 32`), (3) `POST /api/admin/encrypt-tokens` (Bearer `ADMIN_SECRET`) repetido con el cursor hasta `siguienteCursor: null` y `pendientes: 0` (ver "Cifrado de tokens" más abajo), (4) recién entonces borrar `TOKEN_ENCRYPTION_KEY_PREVIOUS` | Con `PREVIOUS` cargada nada se corta. **Nunca** reemplazar la clave sin dejar la anterior en `PREVIOUS`: los tokens guardados quedan ilegibles y todos tienen que reconectar |
| `GOOGLE_CLIENT_SECRET` / `MICROSOFT_CLIENT_SECRET` | Generar uno nuevo en Google Cloud / Entra ID, cargarlo en Pages, después borrar el viejo | Ninguno si se hace en ese orden |
| `CLOUDFLARE_API_TOKEN` (GitHub) | Cloudflare → My Profile → API Tokens: *Roll*; actualizar en GitHub | Deploys fallan hasta actualizarlo |

Los secrets de Pages se leen en cada request: no hace falta redeploy, pero sí esperar ~1 minuto.
Verificar con `npx wrangler pages secret list --project-name fisture` y `GET /api/health`.

## 6. Casos conocidos

### KV agotado (`KV put() limit exceeded for the day`)

Pasó el 2026-10-26: el login escribía en KV y el plan Free admite 1.000 escrituras por día. Desde docs/20 y
docs/21 el login y las sesiones no escriben en KV. Si vuelve a aparecer: buscar el `put` nuevo en el último
deploy (`git log -p -S "KV.put"`), y como alivio temporal subir a Workers Paid. El contador se reinicia
a las 00:00 UTC (21:00 en Argentina).

### Login caído

1. `/api/health` con `oauthState: fail` → falta `OAUTH_STATE_SECRET` en Pages (§5). Con `tokenKey: fail` → falta
   `TOKEN_ENCRYPTION_KEY` (o no tiene 32 bytes en base64): el login redirige a `oauth_failed` y se loguea
   `token_key_missing`. Cargarla en Pages (producción y preview, docs/08 §5) y esperar ~1 minuto.
2. Errores `redirect_uri_mismatch` en el log → la URI registrada en Google/Entra no coincide con
   `https://fisture.com/api/auth/callback/<provider>`.
3. Bloqueos del WAF: Security → Events, filtrar por `/api/auth/*` (regla del ASN 32934, docs/20 §10).

### Cifrado de tokens: backfill y rollback (docs/15)

- **Release B (K18)**: desde este release un token sin el prefijo `enc:v1:` ya no se lee: el usuario ve "reconectar el calendario". Antes de mergearlo hay que ver `tokensSinCifrar` en 0 (usuarios e identidades) en `GET /api/admin/status`; si no, correr el backfill `encrypt` (el recorrido sí cifra los valores en claro). Para revertirlo basta con volver al deployment anterior (§1): los datos no cambian. El backfill de producción del 2026-11-09 dio `pendientes: 0`.

- **Backfill** tras el Release A (con `TOKEN_ENCRYPTION_KEY` ya cargada). Cada llamada mira hasta 20 filas
  (primero `users`, después `oauth_identities`, ordenadas por id) y responde
  `{ direccion, cursor, siguienteCursor, procesadas, ilegibles, pendientes }`. Iterar con el cursor hasta que
  `siguienteCursor` sea `null` **y** `pendientes` sea `0`:
  `curl -X POST "https://fisture.com/api/admin/encrypt-tokens?cursor=<siguienteCursor>" -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" -d "{}"` (sin Content-Type, la protección CSRF de Astro responde 403). Más simple: Actions → "Backfill de cifrado de tokens" → Run workflow, que hace todo el recorrido con el secret de GitHub
  (el entorno por defecto es `staging`; `produccion` solo corre lanzado desde `main`, y `decrypt` en
  producción exige escribir `produccion` en `confirmar`)
  (la primera llamada va sin `cursor`). Una pasada completa recorre todas las filas; si `pendientes` no es 0 al
  final (una fila cambió mientras corría: un login o una renovación), repetir la pasada desde el principio.
  - `procesadas`: filas realmente escritas. Las escrituras son condicionales sobre lo leído: si la fila cambió
    entre la lectura y el batch, se saltea y cuenta como pendiente.
  - `ilegibles`: filas cifradas de esta página que ni la clave actual ni la anterior abren. No se tocan y no
    cuentan como pendientes. Si son estables (aparecen igual en cada pasada) se resuelven cuando ese usuario
    reconecta su calendario (el login pisa los tokens con unos nuevos).
  - `pendientes`: por convertir. Mientras `siguienteCursor` no es `null` cuenta lo que queda después del cursor
    (más las filas que cambiaron durante la corrida). En la **última página** (`siguienteCursor: null`) cuenta el
    total real que queda en la dirección pedida (un COUNT por tabla), incluidas las filas salteadas en páginas
    anteriores: la última respuesta es la verdad. En `decrypt` eso incluye las `ilegibles`, que siguen cifradas
    (el código viejo tampoco las lee), así que `pendientes` puede no llegar a 0 por ellas. Con
    `TOKEN_ENCRYPTION_KEY_PREVIOUS` cargada (rotación) sigue siendo una cota superior, porque no se sabe qué filas
    usan la clave anterior sin leerlas.
  - `GET /api/admin/status` muestra `tokensSinCifrar` (`usuarios` e `identidades` que siguen en claro).
  - Errores: `503 token_key_missing` (falta la clave), `503 token_key_previous_invalid` (la clave anterior no
    tiene 32 bytes en base64: corregirla o borrarla; `/api/health` lo marca `tokenKey: degraded`) y
    `400 cursor_invalido`.
  - **`TOKEN_ENCRYPTION_KEY_PREVIOUS` mal formada durante una rotación**: el backfill responde 503, pero el resto
    de la app sigue andando. El descifrado la trata como ausente y loguea una vez por instancia
    `token_key_previous_invalid` (warn). Efecto: la clave actual funciona igual; solo las filas cifradas con la clave
    vieja quedan ilegibles (esos usuarios reconectan), igual que si `PREVIOUS` no estuviera cargada. El
    barrido de calendarios ya no se corta para todos. `/api/health` la sigue marcando `tokenKey: degraded`:
    corregir la clave (32 bytes en base64) o borrarla y repetir la rotación.
- **Rollback del Release A** (sigue vigente tras el Release B; si hace falta revertir hasta antes del cifrado, primero el B y después el A): el código anterior no entiende `enc:v1:`. Antes de revertir, devolver las filas a
  texto plano con `POST /api/admin/encrypt-tokens?direction=decrypt`, iterando con el cursor igual que el
  backfill hasta `siguienteCursor: null` y `pendientes: 0`. **Necesita una ventana de mantenimiento**:
  mientras corre el `decrypt`, el Release A sigue desplegado y vuelve a cifrar en cada login o renovación. Hacerlo
  en un horario de poco tráfico, sin pausas largas entre llamadas, y revertir el código apenas termine. Los
  pocos usuarios que ingresaron o renovaron en el medio quedan con tokens cifrados que el código viejo no lee:
  verlo en `tokensSinCifrar` (cuenta los que están en claro, así que ahí aparecen como faltantes en el total),
  y cada uno reconecta su calendario (la UI ya lo pide). No hay pérdida de datos. Una pasada final del
  `decrypt` justo antes de revertir acota ese número. Por qué no un interruptor de "escribir en claro": agrega
  un camino de código que guarda tokens sin cifrar, que es justo lo que este diseño evita (docs/15 D6), para
  cubrir un rollback que ocurre una vez y cuyo costo ya es acotado.

### Un usuario legítimo queda limitado (429 `rate_limited`) o bloqueado por origen (403 `forbidden_origin`)

Diseño: `docs/16`. El usuario ve "Demasiados intentos. Probá de nuevo en N segundos" (429 con `Retry-After`).
Las ventanas son de 1 minuto a 15 minutos y se reinician solas: **si puede esperar, esperar es la solución**.

1. Confirmar: en el log buscar `rate_limited` (`bucket`, `scope`, `limit`, `retryAfter`; sin IP) con
   `npx wrangler pages deployment tail --project-name fisture`, o pedir el `x-request-id` de la respuesta.
   `GET /api/admin/status` trae `rateLimit.ultimas24h`: por bucket, `hits` (hasta `limit + 1` por sujeto y ventana), `blocked`
   (sujetos-ventana bloqueados) y `subjects`. Si `blocked` es más del 5% de `subjects` en un bucket durante un día, el límite está mal calibrado (subirlo en `lib/rate-limit/policies.ts`,
   hotfix `fix/*` desde `main`) o hay abuso.
2. **Apagar el límite de tasa ya (sin deploy ni secret), si afecta a varios usuarios o si D1 se acerca al tope de escrituras:**
   un secret de Pages solo toma efecto en el siguiente deploy, así que el interruptor es una clave de KV (se lee con caché
   de 45 s por isolate, más la propagación de KV: tarda 1-2 minutos). Producción:
   `npx wrangler kv key put "ratelimit:modo" "off" --namespace-id 8a9fc92ed9774806833736d1bec711bb`
   (agregar `--ttl 3600` para que se reactive solo en una hora). Staging: el mismo comando con
   `--namespace-id eb9880ef072042d8b93e46a6ca9e49d7`. Para pasar a "solo observar": valor `"observe"`; para forzar el
   bloqueo aunque un secret diga otra cosa: `"on"`. Al resolverlo, volver al valor de arranque borrando la clave:
   `npx wrangler kv key delete "ratelimit:modo" --namespace-id 8a9fc92ed9774806833736d1bec711bb`.
   `RATE_LIMIT_DISABLED` / `RATE_LIMIT_MODE` (secrets) siguen valiendo como arranque cuando la clave no existe (cambiarlos
   exige un deploy). Con `off` el limitador no escribe en D1. Con wrangler 4, agregar `--remote` a los comandos de KV.
   El chequeo de origen no se apaga con esto (es un control de seguridad aparte).
3. **Liberar a un solo usuario o IP** (NAT compartido: colegio, oficina, operadora móvil): borrar su fila.
   - Por usuario, el `subject` es su `users.id`:
     `npx wrangler d1 execute fisture-db --remote --command "DELETE FROM rate_limits WHERE subject = '<users.id>'"`.
   - Por IP, el `subject` es el HMAC de la IP con `RATE_LIMIT_SALT` (o `ADMIN_SECRET` si no está). Una IPv6 se agrupa
     por su /64: se usa `h1:h2:h3:h4::/64` (los cuatro primeros grupos en minúscula y sin ceros a la izquierda, p. ej.
     `2001:db8:abcd:12::/64`) en lugar de la IP; una IPv4 va tal cual. Calcularlo en la
     terminal, sin pegar la IP en ningún issue ni PR:
     `SAL='<RATE_LIMIT_SALT>' IP='<ip>' node -e "console.log(require('node:crypto').createHmac('sha256',process.env.SAL).update(process.env.IP).digest('base64url').slice(0,22))"`
     y luego el `DELETE ... WHERE subject = '<hash>'` de arriba.
4. **403 `forbidden_origin`** en un navegador legítimo: entra por un origen que no es `PUBLIC_APP_URL` y su navegador no
   manda `Sec-Fetch-Site` (versiones viejas, proxys que lo quitan). Cargar el origen en `ALLOWED_ORIGINS`
   (`echo 'https://www.fisture.com' | npx wrangler pages secret put ALLOWED_ORIGINS --project-name fisture`).
5. **`POST /api/admin/sync` o `GET /api/admin/status` responden 429**: hubo 5 Bearer inválidos desde esa IP en los últimos
   15 minutos (por ejemplo un `ADMIN_SECRET` mal rotado en GitHub, §5). Un Bearer correcto nunca recibe 429, así que si
   el 429 llega con el secret bien cargado el problema es otro (revisar el `x-request-id`). `sync-por-lotes.sh` corta ante
   `rate_limited` en vez de seguir. Corregir el secret y esperar 15 minutos, o borrar la fila de `admin_fail` (paso 3).
   Para ver qué `bucket` es: `SELECT bucket, SUM(count) FROM rate_limits GROUP BY bucket`.

### Sync en `fail` o `degraded`

`/api/admin/status` muestra los errores por competencia. Un error de ESPN en una competencia deja el run en
`partial` sin afectar a las demás. Si ESPN cambió un slug, corregirlo en `LEAGUES_CONFIG` (`docs/09`).

Las ligas y los calendarios se miden por separado (`checks.sync` y `checks.calendars` de `/api/health`;
`runs` y `runsCalendarios` en `/api/admin/status`). `checks.calendars` nunca pasa de `degraded` (un fallo de
calendarios no debe dar 503 ni bloquear deploys). `degraded` significa: el último lote falló (ver su `error` en
`runsCalendarios`), el barrido quedó incompleto (llegó al tope de 40 lotes con usuarios pendientes, o un lote no
alcanzó para procesar ni un evento) o el último barrido exitoso tiene más de 26 h. Acción: lanzar un barrido a
mano (§4); si el barrido queda incompleto varios días seguidos, hay más usuarios con trabajo que capacidad
(docs/17 §12). Sin ningún run de calendarios el check está en `ok`.

### Antes del release con la migración 0010 (identidades OAuth, docs/18): paso obligatorio

La migración `0010_oauth_identities.sql` normaliza `users.email` (`lower(trim(email))`) y crea un índice único
sobre `lower(email)`. Si dos usuarios difieren solo en mayúsculas o espacios, **aborta** y traba `deploy.yml` y
`staging.yml`. Por eso, **antes de abrir el PR de release** (y antes de mergear a `development`, que despliega
staging), correr contra producción y staging:

```bash
node scripts/check-email-collisions.mjs          # fisture-db y fisture-staging; sale con 1 si hay colisiones
# o a mano, por base:
npx wrangler d1 execute fisture-db --remote --command "SELECT lower(trim(email)) e, COUNT(*) c FROM users GROUP BY e HAVING c>1"
npx wrangler d1 execute fisture-staging --remote --command "SELECT lower(trim(email)) e, COUNT(*) c FROM users GROUP BY e HAVING c>1"
```

La salida tiene emails: se mira en la terminal y no se pega en issues ni PRs. Sin filas, se puede seguir. **Con filas,
no se mergea hasta resolverlas**, a mano, de a un par:

1. Anotar el bookmark de Time Travel (`npx wrangler d1 time-travel info <db>`, §3).
2. Elegir qué cuenta sobrevive (la que tiene equipos, eventos sincronizados o sesiones más recientes; consultar
   `user_teams`, `calendar_syncs` y `sessions` de cada `id`). Si no hay una clara, preguntar a las personas por el canal
   de soporte (docs/25).
3. Pasar los datos de la que se va (`<viejo>`) a la que queda (`<nuevo>`). `OR IGNORE` descarta lo que ya existe en la
   que queda por los índices únicos:
   ```sql
   UPDATE OR IGNORE user_teams SET user_id = '<nuevo>' WHERE user_id = '<viejo>';
   UPDATE OR IGNORE calendar_syncs SET user_id = '<nuevo>' WHERE user_id = '<viejo>';
   DELETE FROM users WHERE id = '<viejo>';  -- borra por cascada sus preferencias, sesiones y lo que quedó
   ```
4. Volver a correr el chequeo hasta que no devuelva filas. Si los eventos de `calendar_syncs` pertenecían a otro
   proveedor de calendario que el de la cuenta que queda, la reconciliación del cron los trata como `detached`/`failed`
   (docs/11): avisar a la persona.

También, con esa misma base de producción, revisar el **riesgo del Escenario C heredado** (docs/18 §1.2): el backfill
copia `users.*` tal cual a `oauth_identities`, y un usuario que ya tenía los tokens de un proveedor pisados por el
otro seguirá con tokens que no sirven. Cuentas `google` con un token que no parece de Google (heurística, solo vale
mientras los tokens estén en claro, es decir, antes del TDD 15):

```sql
SELECT COUNT(*) FROM users WHERE provider = 'google' AND access_token IS NOT NULL AND access_token NOT LIKE 'ya29.%';
```

Esas personas ven la sincronización de calendario rota hasta que reingresan (el reingreso reescribe los tokens de su
identidad correcta). No hay migración automática posible: el token ajeno no se puede "devolver".

### Una persona recibe `email_en_uso` y dice que la cuenta es suya (pre-secuestro, docs/18 V-17)

`email_en_uso` es el comportamiento esperado cuando alguien entra con un proveedor y ya existe una cuenta con ese
email que no se puede unir sola. Si la persona asegura que **nunca tuvo cuenta** (o que la cuenta que la bloquea no es
suya), puede ser que otra persona se registró antes con el email ajeno (por ejemplo, desde un tenant propio de Entra
que fija el `mail`). La pantalla no dice con qué proveedor está la otra cuenta; eso se mira solo desde soporte:

1. Pedir el email por el canal de soporte (docs/25) y **verificar que controla el buzón**: responder desde la casilla de
   soporte a esa dirección y esperar la respuesta. Sin eso no se toca nada.
2. Mirar la cuenta que bloquea, sin exponer tokens:
   ```sql
   SELECT u.id, u.provider, u.email_verified, u.created_at,
          (SELECT COUNT(*) FROM user_teams t WHERE t.user_id = u.id) AS equipos,
          (SELECT COUNT(*) FROM calendar_syncs c WHERE c.user_id = u.id) AS eventos,
          (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id) AS sesiones
   FROM users u WHERE lower(u.email) = lower('<email>');
   ```
3. Solo si `email_verified = 0` (nadie verificó ese email) y la cuenta no tiene actividad real que explique que es de
   la persona, **liberar el email sin borrar la cuenta** (queda como evidencia):
   ```sql
   UPDATE users SET email = id || '@sin-verificar.invalid' WHERE id = '<id>';
   ```
   y pedirle que vuelva a entrar con su proveedor: se le crea una cuenta nueva. Si `email_verified = 1` o hay
   actividad, **no se libera**: se le explica que entre con el proveedor original y vincule el otro desde Configuración.
4. Dejar anotado el caso (sin el email) en el issue de incidente si hay indicios de abuso.

### Calendarios de usuarios sin acceso

`metricas.calendariosSinAcceso` en `/api/admin/status` cuenta los usuarios en `reauth_required`: el proveedor
falló su token (`invalid_grant`, sin refresh token o sin access token). Un 401 del proveedor que persiste tras renovar no cuenta: la fila se reintenta al día siguiente. Salen de la cola del sync hasta que vuelven a iniciar sesión (el login
los reactiva). No es un fallo del sistema y no cambia el estado de `/api/health`. Un número que crece de golpe
suele indicar un problema de credenciales de la app (cliente OAuth revocado o secret rotado): revisar §5.

### Los workflows programados dejaron de correr

GitHub desactiva los `schedule` tras 60 días sin actividad en el repo y no avisa. La inactividad apaga **todos** los
workflows programados a la vez, `keepalive.yml` incluido, por lo que reactivar ante `disabled_inactivity` sirve de
poco. Lo que realmente protege es que el `PUT .../enable` de `keepalive.yml` (lunes) reinicie el plazo de 60 días,
y eso todavía no está verificado (docs/17 §12). Intenta volver a habilitarlos con la API y abre un issue `incidente` si encontró alguno desactivado o si `sync-cron.yml`
lleva más de 72 h sin terminar bien. Si aun así dejaron de correr (por ejemplo, también se desactivó
`keepalive.yml`): GitHub → Actions → elegir el workflow → **Enable workflow**, y lanzar **Sync diario** a mano.
Cualquier commit, PR o deploy reinicia el plazo de 60 días. El respaldo que no depende de GitHub es un monitor
externo gratuito (por ejemplo UptimeRobot) sobre `https://fisture.com/api/health` con una palabra clave
(`"status":"ok"`) o alerta ante 503: es una decisión del dueño (docs/17 §12).

## 7. A quién avisar

Hoy el proyecto tiene un solo administrador (ver la tarjeta de 2FA y dueño de respaldo). Si el incidente afecta
datos personales (filtración, acceso indebido), además de resolverlo hay que evaluar el aviso a los usuarios y a
la AAIP (Ley 25.326). Dejar todo registrado en el issue `incidente`.
