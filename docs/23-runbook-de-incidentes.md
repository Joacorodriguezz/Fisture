# Runbook de incidentes y rollback

Qué hacer cuando algo se rompe en producción (`https://fisture.com`). Cada paso dice cómo verificar que funcionó.
Proyecto de Pages: `fisture`. Base D1: `fisture-db`. Los comandos de `wrangler` se corren desde la raíz del repo
con una sesión de `npx wrangler login` (o `CLOUDFLARE_API_TOKEN` en el entorno).

## 0. Primeros cinco minutos

1. `curl -s https://fisture.com/api/health` → `ok`, `degraded` o `fail` (503), con el detalle por chequeo
   (`db`, `kv`, `sync`, `oauthState`).
2. Detalle del sync: `curl -s -H "Authorization: Bearer $ADMIN_SECRET" https://fisture.com/api/admin/status`
   (salud + últimos 20 runs con sus errores).
3. Logs en vivo: `npx wrangler pages deployment tail --project-name fisture` (JSON; filtrar por `requestId`
   si el usuario lo tiene del header `x-request-id`).
4. ¿Coincide con un deploy? Ver la última corrida de **Deploy a producción** en GitHub Actions.

Avisos automáticos: `monitor.yml` (cada 30 min) y `sync-cron.yml` abren un issue con la etiqueta `incidente`
y lo cierran al recuperarse. Comentar en ese issue lo que se va haciendo: queda como registro.

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
- Sin `Content-Type: application/json` la protección CSRF de Astro responde 403.

## 5. Revocar y rotar un secret

| Secret | Dónde se rota | Efecto de rotarlo |
| --- | --- | --- |
| `ADMIN_SECRET` | `npx wrangler pages secret put ADMIN_SECRET --project-name fisture` **y** el secret del mismo nombre en GitHub Actions | Ninguno para usuarios. Sin actualizar GitHub, el sync diario falla con 401 |
| `OAUTH_STATE_SECRET` | `openssl rand -base64 32 \| npx wrangler pages secret put OAUTH_STATE_SECRET --project-name fisture` | Los logins en curso (10 min) fallan y hay que reintentar |
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

1. `/api/health` con `oauthState: fail` → falta `OAUTH_STATE_SECRET` en Pages (§5).
2. Errores `redirect_uri_mismatch` en el log → la URI registrada en Google/Entra no coincide con
   `https://fisture.com/api/auth/callback/<provider>`.
3. Bloqueos del WAF: Security → Events, filtrar por `/api/auth/*` (regla del ASN 32934, docs/20 §10).

### Un usuario legítimo queda limitado (429 `rate_limited`) o bloqueado por origen (403 `forbidden_origin`)

Diseño: `docs/16`. El usuario ve "Demasiados intentos. Probá de nuevo en N segundos" (429 con `Retry-After`).
Las ventanas son de 1 minuto a 15 minutos y se reinician solas: **si puede esperar, esperar es la solución**.

1. Confirmar: en el log buscar `rate_limited` (`bucket`, `scope`, `limit`, `retryAfter`; sin IP) con
   `npx wrangler pages deployment tail --project-name fisture`, o pedir el `x-request-id` de la respuesta.
   `GET /api/admin/status` trae `rateLimit.ultimas24h`: por bucket, `hits`, `blocked` y `subjects`. Si `blocked` es más
   del 5% de `hits` en un bucket durante un día, el límite está mal calibrado (subirlo en `lib/rate-limit/policies.ts`,
   hotfix `fix/*` desde `main`) o hay abuso.
2. **Apagar el límite de tasa ya (sin deploy), si afecta a varios usuarios:**
   `echo true | npx wrangler pages secret put RATE_LIMIT_DISABLED --project-name fisture` (staging: `--env preview`).
   Se lee en cada request (esperar ~1 minuto, §5). Para pasar a "solo observar" en vez de apagar:
   `RATE_LIMIT_MODE=observe`. Al resolverlo: `npx wrangler pages secret delete RATE_LIMIT_DISABLED --project-name fisture`.
   El chequeo de origen no se apaga con esto (es un control de seguridad aparte).
3. **Liberar a un solo usuario o IP** (NAT compartido: colegio, oficina, operadora móvil): borrar su fila.
   - Por usuario, el `subject` es su `users.id`:
     `npx wrangler d1 execute fisture-db --remote --command "DELETE FROM rate_limits WHERE subject = '<users.id>'"`.
   - Por IP, el `subject` es el HMAC de la IP con `RATE_LIMIT_SALT` (o `ADMIN_SECRET` si no está). Calcularlo en la
     terminal, sin pegar la IP en ningún issue ni PR:
     `SAL='<RATE_LIMIT_SALT>' IP='<ip>' node -e "console.log(require('node:crypto').createHmac('sha256',process.env.SAL).update(process.env.IP).digest('base64url').slice(0,22))"`
     y luego el `DELETE ... WHERE subject = '<hash>'` de arriba.
4. **403 `forbidden_origin`** en un navegador legítimo: entra por un origen que no es `PUBLIC_APP_URL` y su navegador no
   manda `Sec-Fetch-Site` (versiones viejas, proxys que lo quitan). Cargar el origen en `ALLOWED_ORIGINS`
   (`echo 'https://www.fisture.com' | npx wrangler pages secret put ALLOWED_ORIGINS --project-name fisture`).
5. **`POST /api/admin/sync` o `GET /api/admin/status` responden 429**: hubo 5 Bearer inválidos desde esa IP en los últimos
   15 minutos (por ejemplo un `ADMIN_SECRET` mal rotado en GitHub, §5), y entonces se rechaza incluso el Bearer correcto
   hasta que venza la ventana. Corregir el secret y esperar 15 minutos, o borrar la fila de `admin_fail` (paso 3).
   Para ver qué `bucket` es: `SELECT bucket, SUM(count) FROM rate_limits GROUP BY bucket`.

### Sync en `fail` o `degraded`

`/api/admin/status` muestra los errores por competencia. Un error de ESPN en una competencia deja el run en
`partial` sin afectar a las demás. Si ESPN cambió un slug, corregirlo en `LEAGUES_CONFIG` (`docs/09`).

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

## 7. A quién avisar

Hoy el proyecto tiene un solo administrador (ver la tarjeta de 2FA y dueño de respaldo). Si el incidente afecta
datos personales (filtración, acceso indebido), además de resolverlo hay que evaluar el aviso a los usuarios y a
la AAIP (Ley 25.326). Dejar todo registrado en el issue `incidente`.
