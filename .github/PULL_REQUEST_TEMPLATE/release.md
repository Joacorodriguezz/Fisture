<!--
Release `development` → `main`. Mergear con "Create a merge commit".
Para usar esta plantilla: ?template=release.md en la URL de creación del PR.
Título sugerido: `release: <resumen corto>`
-->

## Qué incluye

<!-- PRs mergeados desde el último release. -->
- #

## Pasos de despliegue

- [ ] Migraciones D1 a aplicar (`npm run db:migrate:prod`): ninguna / `000X_nombre`
- [ ] Variables de entorno o secretos nuevos: ninguno / listar
- [ ] Verificado el preview de `development`

## Riesgos y rollback

<!-- Qué puede salir mal y cómo se revierte. -->

## Verificación post-deploy

- [ ] `GET /api/health` responde 200
- [ ] Último run en `/api/admin/status` sin errores
