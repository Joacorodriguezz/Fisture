# TDD: Staging de `development` en Cloudflare Pages

Estado: implementado (2026-11-03), a pedido del usuario y sin revisión previa del diseño.

## 1. Contexto y problema

Pages no tiene Git conectado: solo `main` se despliega (`deploy.yml`). Lo que se mergea en `development` no se puede
ver en ningún lado hasta el release, y las migraciones nuevas se prueban por primera vez contra la base de
producción. Levantar la app en local (o en Docker, que corre lo mismo: wrangler y Miniflare) no sirve para mostrarla
ni para probarla desde el celular.

## 2. Objetivos y no objetivos

Objetivos: URL fija con lo último de `development`, base y KV propios, migraciones probadas antes de producción, datos
reales de ESPN y nada indexado por buscadores.

No objetivos: copiar datos de producción (usuarios, tokens) a staging; previews por PR; proteger la URL con Cloudflare
Access (se puede sumar después).

## 3. Decisiones

**D1. Preview de Pages con alias de rama.** `wrangler pages deploy --branch development` publica en
`https://development.fisture.pages.dev`. Descartado: un segundo proyecto de Pages (otro dominio, otra configuración).

**D2. `[env.preview]` en `wrangler.toml`.** Pages usa esa sección para todo deploy que no es de producción: D1
`fisture-staging`, KV propio, `ENVIRONMENT=staging` y `PUBLIC_APP_URL` de staging. Producción sigue con la
configuración de arriba. Los secrets de preview son otros (`wrangler pages secret put ... --env preview`).

**D3. `staging.yml`.** En cada push a `development` corre la suite (mismo artefacto que se despliega), migra
`fisture-staging`, despliega, sincroniza por lotes y corre el smoke de solo lectura. Además se resincroniza una vez por
día. El secret `STAGING_ADMIN_SECRET` de GitHub es distinto del de producción.

**D4. Staging no se indexa.** Con `ENVIRONMENT=staging`: `<meta name="robots" content="noindex">` en todas las
páginas, `robots.txt` con `Disallow: /` y una franja "Staging · rama development".

**D5. Cookies `Secure` también en staging** (es HTTPS). Antes dependían de `ENVIRONMENT === "production"`.

**D6. Sync compartido.** El loop de lotes pasa a `.github/scripts/sync-por-lotes.sh`, que usan producción y staging.

**D7. Login en staging con credenciales OAuth propias.** El cliente de Google de producción está en verificación y sus
dominios autorizados son de `fisture.com`; sumarle `pages.dev` lo complicaría. Staging usa un cliente de Google y una
app de Entra ID aparte (modo prueba, usuarios de prueba). Hasta que se carguen, en staging funciona todo lo público pero
no el login.

## 4. Estrategia de tests

- `robots.test.ts`: en staging bloquea todo y no publica el sitemap.
- `login.test.ts`: la cookie del estado es `Secure` en staging y no en `test`.
- Script de lotes probado contra un servidor falso (1102 una vez y después ok; lote con 500 persistente; 401 corta).
- Manual, contra Cloudflare real: migraciones `0000` a `0009` en `fisture-staging`, deploy, 43 competencias
  sincronizadas, `/api/health` en `ok`, flujo Liga Profesional → Estudiantes con sus 5 competencias.

## 5. Despliegue y rollback

Recursos creados: D1 `fisture-staging` (`4cfee6a5-…`), KV `fisture-staging` (`eb9880ef…`), secrets de preview
`OAUTH_STATE_SECRET` y `ADMIN_SECRET`, secret de GitHub `STAGING_ADMIN_SECRET`. Para apagar staging: borrar
`staging.yml`; los deploys de preview se borran desde el dashboard de Pages. No afecta producción.

## 6. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Un secret de preview cambia y el deploy viejo sigue con el anterior | En Pages los secrets se aplican en el próximo deploy: redeployar después de cambiarlos |
| Staging y producción comparten cuota del plan Free (requests, CPU) | Staging tiene un sync diario y casi no tiene tráfico (D4) |
| La URL es pública | `noindex` y franja; si hace falta, Cloudflare Access sobre `development.fisture.pages.dev` |

## 7. Plan de implementación

1. Crear D1 y KV de staging. 2. `[env.preview]`. 3. `noindex`, `robots.txt`, franja y cookies (tests primero).
4. Script de lotes compartido. 5. `staging.yml`. 6. Primer deploy y sync manuales. 7. Credenciales OAuth de staging.

## 8. Preguntas abiertas

- ¿Se protege staging con Cloudflare Access?

## 9. Notas de implementación (desvíos respecto del diseño original)

- **Error 1102 en Workers Free.** El primer sync de staging hizo los 9 lotes seguidos y los dos últimos (copas de
  Brasil y estaduales) respondieron 503 `error code: 1102` (recursos del Worker excedidos). Reintentados un minuto
  después pasaron sin errores en 12 s y 8 s. Free tolera ráfagas de CPU pero no muchas invocaciones pesadas seguidas.
  El script ahora espera 20 s entre lotes y, ante un 1102, reintenta el mismo lote tras 60 s. Esto también afectaba al
  sync de producción con las 43 competencias de docs/22.
- Los secrets de preview necesitan un redeploy para tomar efecto: el primer sync dio 401 por eso. El script corta al
  primer 401 en lugar de recorrer todos los lotes.
