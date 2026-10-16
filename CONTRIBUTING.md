# Contribuir a Fisture

## Ramas

| Rama | Rol | Método de merge |
|---|---|---|
| `main` | Producción | Merge commit (solo desde `development`, o `fix/*` en hotfix) |
| `development` | Integración / staging | Squash |
| `feat/*`, `fix/*`, `chore/*`, `docs/*`, `ci/*` | Trabajo diario | — |

## Cómo aportar

1. `git checkout development && git pull`
2. `git checkout -b feat/mi-cambio`
3. Commits con Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `ci:`).
4. Verificar localmente con `npm run build`.
5. Abrir PR a `development`. Debe pasar el check `build` y tener las conversaciones resueltas.
6. **Squash and merge**.

## Releases

Cuando `development` esté estable, abrir un PR `development` → `main` y mergear con **Create a merge commit**. El merge deploya a producción.

## Hotfixes

`fix/*` desde `main` → PR a `main` → luego PR de `main` a `development`.
