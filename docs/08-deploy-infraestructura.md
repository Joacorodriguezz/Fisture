# Deploy e Infraestructura - FISTURE

## Stack de Infraestructura

| Servicio | Proveedor | Free Tier |
|----------|-----------|-----------|
| Frontend + API | Cloudflare Pages | Ilimitado |
| Database | Cloudflare D1 | 5 GB |
| Cache/Sessions | Cloudflare KV | 100k lecturas/día |
| Storage (logos) | Cloudflare R2 | 10 GB |
| Cron Jobs | Cloudflare Workers | Incluido |
| CDN | Cloudflare | Incluido |

## Arquitectura de Deploy

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              GitHub                                      │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │  main branch                                                     │    │
│  └──────────────────────────────┬──────────────────────────────────┘    │
└─────────────────────────────────┼───────────────────────────────────────┘
                                  │ Push
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                         Cloudflare Pages                                 │
│                                                                          │
│  ┌───────────────────┐    ┌───────────────────┐                         │
│  │  Build            │    │  Deploy           │                         │
│  │  - npm install    │───▶│  - 300+ POPs      │                         │
│  │  - astro build    │    │  - Edge Network   │                         │
│  └───────────────────┘    └───────────────────┘                         │
│                                    │                                     │
│                    ┌───────────────┼───────────────┐                    │
│                    │               │               │                    │
│                    ▼               ▼               ▼                    │
│              ┌──────────┐   ┌──────────┐   ┌──────────┐                │
│              │    D1    │   │    KV    │   │    R2    │                │
│              │ Database │   │  Cache   │   │ Storage  │                │
│              └──────────┘   └──────────┘   └──────────┘                │
└─────────────────────────────────────────────────────────────────────────┘
```

## Configuración de Wrangler

```toml
# wrangler.toml
name = "fisture"
compatibility_date = "2024-01-01"
pages_build_output_dir = "./dist"

# D1 Database
[[d1_databases]]
binding = "DB"
database_name = "fisture-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# KV Namespace
[[kv_namespaces]]
binding = "KV"
id = "xxxxxxxx"

# R2 Bucket (opcional)
[[r2_buckets]]
binding = "R2"
bucket_name = "fisture-assets"

# Cron Triggers
[triggers]
crons = ["0 9 * * *"]

# Environment Variables
[vars]
APP_URL = "https://fisture.pages.dev"
ENVIRONMENT = "production"
```

## Pasos de Setup Inicial

### 1. Instalar Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Crear D1 Database

```bash
# Crear database
wrangler d1 create fisture-db

# Copiar el ID al wrangler.toml
# database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

### 3. Crear KV Namespace

```bash
# Crear KV
wrangler kv:namespace create KV

# Copiar el ID al wrangler.toml
```

### 4. Aplicar Migraciones

```bash
# Generar migraciones
npx drizzle-kit generate

# Aplicar a D1 local
wrangler d1 execute fisture-db --local --file=./drizzle/migrations/0000_init.sql

# Aplicar a D1 producción
wrangler d1 execute fisture-db --file=./drizzle/migrations/0000_init.sql
```

### 5. Configurar Secrets

```bash
# OAuth
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put MICROSOFT_CLIENT_ID
wrangler secret put MICROSOFT_CLIENT_SECRET
wrangler secret put APPLE_CLIENT_ID
wrangler secret put APPLE_TEAM_ID
wrangler secret put APPLE_KEY_ID
wrangler secret put APPLE_PRIVATE_KEY

# API Football
wrangler secret put RAPIDAPI_KEY

# Admin
wrangler secret put ADMIN_SECRET
```

### 6. Conectar con GitHub

1. Ir a https://dash.cloudflare.com
2. Pages → Create a project → Connect to Git
3. Seleccionar repositorio
4. Configurar:
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Root directory: `/`
5. Agregar variables de entorno en Settings

### 6.1 Observabilidad después del deploy

1. Aplicar las migraciones (`npm run db:migrate:prod`) **antes** del deploy: la `0004_sync_runs` crea la tabla del historial de sync.
2. Configurar el secret `ADMIN_SECRET` (lo usan `/api/admin/sync` y `/api/admin/status`).
3. Verificar `GET https://<dominio>/api/health`. Devuelve 503 (`sync: fail`) hasta que haya un sync exitoso registrado: lanzar uno con `POST /api/admin/sync` (Bearer `ADMIN_SECRET`).
4. Logs en vivo: `npx wrangler pages deployment tail`; histórico en el dashboard (Workers & Pages → proyecto → Logs).
5. Monitor externo recomendado (UptimeRobot, Better Stack, Cloudflare Health Checks) sobre `/api/health` con aviso por mail o Telegram.
6. **Cron en Pages:** Pages no ejecuta Cron Triggers. El sync diario lo dispara `.github/workflows/sync-cron.yml` (9:00 UTC), que llama a `POST /api/admin/sync`. Requiere los secrets de GitHub `PUBLIC_APP_URL` (ej. `https://fisture.pages.dev`, sin barra final) y `ADMIN_SECRET` (el mismo de Cloudflare). También se puede lanzar a mano desde Actions → Sync diario → Run workflow. Si deja de correr, `/api/health` pasa a `degraded` a las 26 h y a `fail` a las 50 h.

Detalle del diseño: `docs/10-observabilidad-tdd.md`.

### 6.2 Deploy automático (proyecto de subida directa)

El proyecto `fisture` de Pages **no tiene Git conectado**, así que mergear a `main` no deploya solo. Lo hace `.github/workflows/deploy.yml` en cada push a `main` (o a mano desde Actions): tests, build, migraciones de D1 (`wrangler d1 migrations apply --remote`) y `wrangler pages deploy dist`. Secrets de GitHub requeridos:

- `CLOUDFLARE_API_TOKEN`: token con permisos *Cloudflare Pages: Edit* y *D1: Edit* (dashboard → My Profile → API Tokens → Create Token).
- `CLOUDFLARE_ACCOUNT_ID`
- `PUBLIC_APP_URL` y `ADMIN_SECRET` (los usa el workflow del cron de sync).

`ENVIRONMENT` y `PUBLIC_APP_URL` salen de `wrangler.toml` (`[vars]`). Los secrets de la app (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ADMIN_SECRET`, `FOOTBALL_DATA_API_KEY`, etc.) se cargan con `npx wrangler pages secret put <NOMBRE> --project-name fisture`.

### 7. Configurar Dominio (Opcional)

1. Pages → tu proyecto → Custom domains
2. Agregar dominio
3. Configurar DNS según instrucciones

## Desarrollo Local

```bash
# Instalar dependencias
npm install

# Iniciar D1 local
wrangler d1 execute fisture-db --local --file=./drizzle/migrations/0000_init.sql

# Iniciar servidor de desarrollo
npm run dev

# O con bindings de Cloudflare
wrangler pages dev --d1=DB --kv=KV -- npm run dev
```

## Scripts de Package.json

```json
{
  "scripts": {
    "dev": "astro dev",
    "build": "astro build",
    "preview": "wrangler pages dev ./dist",
    "deploy": "wrangler pages deploy ./dist",
    "db:generate": "drizzle-kit generate",
    "db:migrate:local": "wrangler d1 execute fisture-db --local --file=./drizzle/migrations/0000_init.sql",
    "db:migrate:prod": "wrangler d1 execute fisture-db --file=./drizzle/migrations/0000_init.sql",
    "db:studio": "drizzle-kit studio"
  }
}
```

## CI/CD con GitHub Actions

```yaml
# .github/workflows/deploy.yml
name: Deploy to Cloudflare Pages

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "20"
          cache: "npm"

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Deploy to Cloudflare Pages
        if: github.ref == 'refs/heads/main'
        uses: cloudflare/pages-action@v1
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          projectName: fisture
          directory: dist
          gitHubToken: ${{ secrets.GITHUB_TOKEN }}
```

## Monitoreo

### Logs

```bash
# Ver logs en tiempo real
wrangler pages deployment tail

# Ver logs de un deployment específico
wrangler pages deployment tail --deployment-id=xxx
```

### Métricas

- **Cloudflare Dashboard** → Pages → tu proyecto → Analytics
- Requests, bandwidth, errores, tiempos de respuesta

### Alertas

- Configurar en Cloudflare Dashboard → Notifications
- Alertas por errores, downtime, etc.

## Costos

### Free Tier (suficiente para empezar)

| Recurso | Límite Free |
|---------|-------------|
| Pages requests | Ilimitado |
| Pages bandwidth | Ilimitado |
| Workers requests | 100k/día |
| D1 storage | 5 GB |
| D1 reads | 5M/día |
| D1 writes | 100k/día |
| KV reads | 100k/día |
| KV writes | 1k/día |
| R2 storage | 10 GB |

### Si crece (Workers Paid - $5/mes)

| Recurso | Límite Paid |
|---------|-------------|
| Workers requests | 10M/mes incluidos |
| D1 storage | 5 GB incluidos |
| KV reads/writes | 10M/mes incluidos |

## Troubleshooting

### Error: D1 database not found

```bash
# Verificar que el ID es correcto
wrangler d1 list

# Recrear si es necesario
wrangler d1 delete fisture-db
wrangler d1 create fisture-db
```

### Error: KV namespace not found

```bash
# Listar namespaces
wrangler kv:namespace list

# Recrear si es necesario
wrangler kv:namespace create KV
```

### Error: OAuth callback failed

1. Verificar redirect URIs en Google Cloud Console / Azure
2. Deben ser:
   - `https://fisture.pages.dev/api/auth/callback/google`
   - `https://fisture.pages.dev/api/auth/callback/microsoft`

### Error: Cron job not running

```bash
# Verificar triggers
wrangler pages deployment tail

# Ejecutar manualmente
curl -X POST https://fisture.pages.dev/api/admin/sync \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

## Checklist de Deploy

### Pre-deploy
- [ ] Migraciones aplicadas a D1
- [ ] Secrets configurados
- [ ] OAuth redirect URIs actualizados
- [ ] Variables de entorno en Pages settings

### Post-deploy
- [ ] Login con Google funciona
- [ ] Login con Microsoft funciona
- [ ] Búsqueda de equipos funciona
- [ ] Sync de calendario funciona
- [ ] Cron job programado

## Rollback

```bash
# Ver deployments anteriores
wrangler pages deployment list

# Hacer rollback
wrangler pages deployment rollback --deployment-id=xxx
```

O desde el dashboard: Pages → Deployments → Click en deployment anterior → Rollback
