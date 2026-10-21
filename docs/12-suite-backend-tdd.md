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

Pendientes de completar tras ejecutar la suite sobre el backend integrado.
