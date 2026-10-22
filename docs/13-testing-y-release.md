# Tests y aprobación de releases del backend actual

La suite valida cada PR a `development` y `main`. El check obligatorio `build` agrega el resultado de todos los jobs: tipos, unitarias, integración con D1, cobertura y navegador. Un job fallido o cancelado impide que el check quede verde. No hay filtros de archivos ni tests omitidos en PRs de release.

## Ejecutar localmente

Requiere Node 22 y las dependencias del lockfile:

```sh
npm ci
npx playwright install chromium
npm run check
```

Comandos individuales:

| Comando | Qué verifica |
| --- | --- |
| `npm run typecheck` | Astro/TypeScript, incluyendo el esquema Drizzle |
| `npm run test:discover` | Todos los archivos de test tienen casos y pertenecen exactamente a un proyecto |
| `npm run test:unit` | Fechas argentinas, ICS, sesiones, contratos HTTP, adaptación ESPN, logging y smoke |
| `npm run test:integration` | Migraciones, consultas y aislamiento de usuarios en D1, endpoints, tokens y sincronización |
| `npm run test:coverage` | Ambas suites Vitest y umbrales de cobertura |
| `npm run build && npm run test:e2e` | Aplicación construida sobre Pages local en Chromium de escritorio y móvil |
| `npm run test:e2e:ui` | Navegador de pruebas interactivo, requiere build previo |
| `npm run test:smoke` | Consultas HTTP de solo lectura contra `PUBLIC_APP_URL` explícita |

Los tests existentes de observabilidad se conservan. Los que mezclan funciones puras y D1 corren en el proyecto `integration`; logger y wrapper HTTP corren en `unit`. Las regresiones de la PR #17 se reorganizaron en `tests/unit/calendar` y `tests/integration/calendar`, y las de autenticación en `tests/unit/auth`. Se conserva el comportamiento del backend nuevo.

Vitest selecciona `tests/unit/**/*.test.ts` como unitarios; los demás archivos `tests/**/*.test.ts` corresponden a integración, con la excepción explícita de logger/wrapper. Las selecciones son complementarias. `test:discover` compara los archivos del filesystem con la colección real de Vitest: falla por imports rotos, archivos vacíos, archivos omitidos, proyectos desconocidos o selección duplicada. `npm test`, `npm run check` y el CI ejecutan este control.

## Datos y dependencias externas

Las pruebas de integración usan una D1 efímera por caso o suite. Las migraciones SQL reales se aplican desde cero, con batches por migración para reducir IPC y liberación del runtime si el setup falla. La migración `0006` también se comprueba desde el esquema anterior con duplicados sembrados. Las APIs externas se simulan en la frontera HTTP con fixtures y respuestas controladas; los tests verifican payloads, errores e idempotencia.

El servidor E2E crea un directorio temporal propio con configuración, D1 y KV locales. Wrangler aplica migraciones, inserta partidos relativos a la fecha de ejecución y sesiones válidas en KV, verifica que reaplicar migraciones no borre los datos, y sirve `dist/`. No lee `wrangler.toml`, `.dev.vars` ni credenciales del proyecto para servir los E2E. El directorio se limpia al terminar normalmente. Una terminación forzada del árbol de procesos puede dejar un directorio `fisture-e2e-*` en el temporal del sistema.

Con Wrangler 3, el runner conecta al inspector local en un puerto efímero y confirma `Network.disable` antes de anunciar readiness. Es una mitigación del [problema de eventos acumulados en ejecución headless](https://github.com/cloudflare/workers-sdk/issues/14191), no un mock del tráfico de aplicación: las requests y el build siguen siendo reales. Si falla el inspector, el runner falla. Revisar la necesidad de esta mitigación al actualizar Wrangler. El entorno soportado de la suite es Node 22; no se declara validada esta ampliación con Node 24.

Cada escenario, proyecto y reintento tiene su propio usuario y sesión. Las pruebas no reutilizan un servidor existente. El navegador bloquea requests a hosts externos. Las operaciones reales de Google/Microsoft se verifican en integración con HTTP simulado; el consentimiento OAuth real requiere comprobación manual con una cuenta de prueba antes de cambiar scopes o configuración del proveedor. No hay bypass de autenticación en la aplicación.

## Flujos críticos

- Lectura pública de ligas/equipos/partidos/calendario; login con `next` seguro para acciones personales.
- Buscar, seguir y dejar de seguir equipos; persistencia del auto-sync.
- Preferencias, recordatorios y tema persistidos tras recargar.
- Ligas, equipos, próximos partidos y detalle.
- Descarga real de archivo ICS con eventos y recordatorios.
- Logout que invalida la sesión en KV, incluso al intentar reutilizar la cookie.
- Fallo de permisos informado sin persistir un falso `failed` del partido (contrato actual de auth).
- Sesiones inválidas eliminadas y APIs personales con JSON 401, sin redirecciones a HTML.
- Estados reprogramado, `detached` y cancelado en las vistas reales.
- Menú móvil con Escape y retorno de foco, cuenta autenticada y navegación.
- Tira de días de Hoy, filtro Mis equipos y ligas colapsables con estado persistido.
- Conteos por día argentino y pantallas sin desbordes horizontales.
- Salud del worker y endpoints administrativos protegidos.
- Integración: creación/actualización/eliminación de eventos en Google y Microsoft, reintentos, requests concurrentes, aislamiento entre usuarios y renovación de tokens.
- Conservar notas y recordatorios al actualizar; errores 401/429/503 no crean eventos nuevos.
- Reconciliación sin auto-sync y respeto por eventos borrados a mano; títulos privados de solapamientos solo en la respuesta, nunca en logs ni D1.
- Ingesta ESPN a D1: sin duplicados al repetir, cambios de horario y equipos compartidos entre competencias.

## Cobertura y resultados

Los umbrales son 90% de líneas, statements y funciones y 85% de branches sobre el conjunto explícito de módulos en `vitest.config.ts`. Calendarios tiene un presupuesto propio más exigente: 95% de líneas/statements/funciones y 90% de branches. Este porcentaje **no representa toda la aplicación**: prioriza fechas, acceso/sesiones/tokens, estados de UI, calendarios, consultas/preferencias, ingesta ESPN, observabilidad y APIs de equipos/preferencias/calendario. Nuevas funciones críticas deben incorporarse al conjunto y tener pruebas del comportamiento.

GitHub conserva `coverage`, `vitest-results` (JUnit) y `playwright-report` por 14 días, incluyendo HTML, screenshots, videos y traces de fallos. `application` conserva por 7 días el build probado. Playwright reintenta una vez en CI con datos separados para diagnóstico, pero `failOnFlakyTests` impide aprobar un resultado inestable; los tests Vitest no tienen reintentos automáticos. Vitest y Playwright prohíben `.only` en CI para que un test focalizado no silencie la suite.

## Release a producción

1. Integrar la feature mediante PR a `development` con `build` verde.
2. Abrir PR `development` → `main`; vuelve a correr la suite completa y se mergea con merge commit.
3. El push a `main` ejecuta la misma suite reutilizable. El job de deploy depende de su éxito.
4. Descargar el artefacto `application` de esa ejecución, aplicar las migraciones pendientes y subir exactamente ese `dist/` a Pages.
5. Ejecutar smoke HTTP contra `PUBLIC_APP_URL`: páginas públicas, salud D1/KV/sync y rechazo de `/api/admin/status` sin credenciales. Los GET toleran fallos transitorios con hasta cuatro intentos y timeout por request.

El disparo manual de Deploy funciona únicamente desde `main`. El CI de pushes a `development` y el pipeline de producción no reciben secretos en los jobs de testing. Los PRs de forks también pueden ejecutar las pruebas aisladas sin credenciales de Cloudflare.

Secrets existentes requeridos para el job de deploy: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` y `PUBLIC_APP_URL` (URL HTTPS canónica). `ADMIN_SECRET` sigue siendo requerido por la aplicación y por el cron, pero el smoke no lo utiliza. El check de URL se hace antes de migrar/desplegar.

## Migraciones y fallos

Aplicar desde cero y comprobar el ledger no demuestra que una migración destructiva sea segura para los datos existentes. Cada cambio de esquema debe usar expand/contract y revisión explícita. La migración histórica `0001` elimina tablas: debe figurar como ya aplicada en producción antes de ejecutar un release sobre una base existente. Este trabajo no agrega migraciones ni cambia el ledger remoto.

Si falla un test previo, no se migra ni despliega. Si falla el smoke después de subir Pages, el workflow queda rojo y muestra instrucciones; no hay rollback automático. Revisar el deployment recién creado y volver al deployment previo desde Cloudflare Pages si corresponde. El rollback de código no revierte D1 y exige compatibilidad con las migraciones aplicadas.

`/api/health` informa fallos del cron además de fallos del deployment: sin sync exitoso o con datos demasiado antiguos devuelve 503. El smoke acepta `degraded` según el contrato actual, pero falla ante `fail`; investigar frescura del sync antes de atribuir ese resultado al código nuevo.

## Referencias

- Diseño de la adaptación: `docs/12-suite-backend-tdd.md`. Contrato de calendario: `docs/11-calendario-casos-borde-tdd.md`.
- [Pages local development](https://developers.cloudflare.com/pages/functions/local-development/).
- [Playwright web server](https://playwright.dev/docs/test-webserver).
- [GitHub reusable workflows](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows).
