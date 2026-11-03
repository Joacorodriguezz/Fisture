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

### Sync en `fail` o `degraded`

`/api/admin/status` muestra los errores por competencia. Un error de ESPN en una competencia deja el run en
`partial` sin afectar a las demás. Si ESPN cambió un slug, corregirlo en `LEAGUES_CONFIG` (`docs/09`).

## 7. A quién avisar

Hoy el proyecto tiene un solo administrador (ver la tarjeta de 2FA y dueño de respaldo). Si el incidente afecta
datos personales (filtración, acceso indebido), además de resolverlo hay que evaluar el aviso a los usuarios y a
la AAIP (Ley 25.326). Dejar todo registrado en el issue `incidente`.
