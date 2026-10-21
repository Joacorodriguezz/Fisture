# TDD: suite de pruebas y CI del backend de calendarios

## Contexto

La suite local anterior se construyó sobre `cd62b28`. La PR #17, integrada en `development` como `5f702de`, cambió clientes, errores, estados y reconciliación del calendario, agregó migraciones y aportó sus propias regresiones. Una configuración de Vitest con includes cerrados puede dejar esas pruebas fuera del CI aun cuando el pipeline esté verde.

## Objetivo y alcance

Adaptar la implementación de testing ya solicitada al backend integrado, conservar todas las regresiones y comprobar la aplicación construida con D1/KV locales. Dar feedback por tipos, pruebas unitarias, integración, cobertura y E2E, sin desplegar ni modificar recursos remotos. La publicación del PR y la producción siguen pendientes de la reanudación del usuario.

## Decisiones

- Integrar la rama de backend publicada y mantener el trabajo local anterior mediante un checkpoint recuperable. Resolver solapamientos conservando el contrato nuevo.
- Reorganizar los tests en proyectos unitarios y de integración. La selección será exhaustiva y excluyente: cada `*.test.ts` deberá corresponder exactamente a un proyecto, incluyendo los de autenticación, migraciones y calendario aportados por la PR.
- Usar dependencias inyectables para reglas del servicio y HTTP simulado para contratos Google/Graph. Conservar pruebas de integración que recorren servicio, cliente y D1 juntos para detectar desacuerdos entre capas.
- Incorporar tests del API real a nivel handler y del middleware mediante el worker construido: lectura pública, acciones personales protegidas, JSON de error, retorno seguro tras login y sesiones inválidas.
- Verificar estados `detached`, `cancelled`, `needs_update`, interrupción por auth/rate limit, conservación de notas/avisos del usuario y migración con datos previos. Probar límites del cron y aislamiento de usuarios sin llamadas externas.
- El CI compartido correrá en cada PR; el check existente `build` agregará todos los resultados. El eventual deploy consumirá el mismo artefacto probado. Reportes, traces y cobertura se conservarán como artifacts.
- La cobertura se medirá sobre módulos críticos explícitos. No se presentará como cobertura de todo el producto ni se bajarán umbrales para aceptar regresiones.

## Alternativas

No reemplazar los tests del backend por la suite anterior: perdería casos de borde. No depender de Google/Microsoft reales en PRs: requiere cuentas, cuotas y credenciales, introduce inestabilidad y no es ejecutable en forks. La validación manual de contratos externos indicada por la PR #17 permanece documentada para el release.

## Estrategia y pasos

1. Integrar cambios publicados y ejecutar toda la colección para identificar expectativas antiguas y tests no descubiertos.
2. Clasificar exhaustivamente y eliminar duplicación de reglas ya cubiertas, conservando pruebas entre capas.
3. Añadir casos faltantes de APIs, privacidad, migraciones y límites; corregir únicamente regresiones demostradas.
4. Actualizar fixtures E2E para navegación pública y nuevos estados. Aislar datos por escenario/proyecto/reintento.
5. Ejecutar `npm run check`, validar workflows y registrar resultados exactos y límites de validación.

La implementación sigue rojo → verde → refactor: primero se reproduce el desacuerdo con el contrato actual, luego se actualizan fixtures/assertions o se corrige el defecto demostrado.

## Release, rollback y riesgos

No se ejecutan deploys ni migraciones remotas. La migración `0006` se verifica desde el esquema anterior con duplicados y desde una instalación nueva. Antes de producción siguen pendientes las comprobaciones reales del proveedor y el seguimiento de dependencias vulnerables. El rollback de código no revierte D1. La navegación pública y la hidratación diferida requieren actualizar los E2E para evitar falsos negativos y clicks antes de que el control esté listo.

## Notas de implementación

- Base efectiva: `origin/development` en `5f702de` (PR #17). Al verificar el estado remoto, `main` seguía en `d4113e9`; no se hizo merge, push ni deploy.
- Se conservó la suite previa mediante un checkpoint local recuperable en `backup/suite-previa-backend` y se integró con rebase. Se preservaron los errores tipados, PATCH, snapshots e índice único del backend nuevo, junto con la corrección UTC de Outlook de la suite anterior.
- Se movieron las regresiones del backend a `tests/unit/calendar`, `tests/integration/calendar` y `tests/unit/auth`. La selección de integración es el complemento de unitarias, auditada contra `vitest list --json` y los archivos reales.
- Los tests entre capas usan un simulador HTTP en memoria: el servicio, los adaptadores y D1 son reales. Las reglas finas del dominio conservan el cliente inyectable de la PR.
- Regresión detectada: `POST /api/calendario/sync` devolvía 500 con body `null` o tipos incorrectos. Se agregó validación de JSON/IDs con respuesta 400 y pruebas que exigen cero llamadas al proveedor y cero filas nuevas.
- El helper D1 libera el runtime si una migración falla y aplica batches por migración para reducir el costo y las conexiones del setup. No se agregaron reintentos de Vitest para ocultar fallos.
- Umbrales elevados: 90% líneas/statements/funciones y 85% branches en el grupo global; 95%/90% para calendarios. Reporte JUnit en CI, además de cobertura y trazas de navegador.
- Resultados finales: `npm run check` pasa tanto en Node 24 local como en Node 22.23.3 con `CI=true`: 32 archivos, 133 tests unitarios, 132 de integración y 22 E2E (escritorio/móvil), sin reintentos necesarios. Typecheck sin errores, build correcto y workflows validados con actionlint 1.7.12.
- Cobertura de los módulos incluidos: 95,26% de líneas, 93,42% de funciones; calendarios: 99,35% de líneas. Los umbrales globales y específicos pasan. El porcentaje de branches puede variar levemente entre las versiones de Node por la instrumentación V8; ambas ejecuciones superaron los mínimos.
- La validación de modo CI fue local en Windows, no una ejecución remota de GitHub Actions. Los contratos con APIs reales siguen pendientes según el TDD de calendario. No se ejecutó `sync:check` porque usa ESPN real; la ingesta queda comprobada con fixtures sin red en integración.
- Se volvió a verificar el descubrimiento después de excluir explícitamente `tests/e2e/**` de Vitest y reducir logs de tests exitosos. Ver guía operativa en `docs/13-testing-y-release.md`.
