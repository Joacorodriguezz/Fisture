# TDD: Actualización de dependencias vulnerables

> Technical Design Document. Estado: **propuesto, pendiente de revisión**. Fecha: 2026-10-23. Rama de implementación: una por etapa (§6), cada una desde `development`.
>
> Este documento registra **qué problema hay hoy, qué decidimos y por qué**. El código se escribe después de que se apruebe, siguiendo el orden del §6.

## 1. Contexto y problema

`npm audit` marca 20 paquetes afectados, casi todos con arreglo solo en una **versión mayor**: `npm audit fix` no los resuelve y `npm audit fix --force` los sube todos a la vez (Astro 5 → 7, adaptador de Cloudflare 12 → 14, Tailwind 3 → 4, Wrangler 3 → 4, Vitest 3 → 5). El doc `12-suite-backend-tdd.md` ya lo deja anotado como pendiente antes de producción.

No todo pesa lo mismo. Lo que importa es qué llega a producción y si la app usa la función afectada:

| Paquete | Dónde corre | Advisories relevantes | ¿Nos alcanza hoy? |
| --- | --- | --- | --- |
| `astro` 5.18 (crítico) | Runtime (Worker) | RCE en optimización de imágenes AVIF; varios XSS reflejados (slots, spread props, `define:vars`, view transitions); SSRF por `Host` en la página de error prerrenderizada; bypass por `base` | Parcial. Ver §1.1 |
| `drizzle-orm` 0.36 (alto) | Runtime (Worker) | SQL injection por identificadores SQL mal escapados (< 0.45.2) | Bajo: los identificadores son fijos en el código; no hay nombres de tabla o columna que vengan del usuario. Pero es el único que toca la base y se arregla con una subida menor de la serie 0.x |
| `@astrojs/cloudflare` 12 (bajo) | Runtime (Worker) | SSRF por redirect en el endpoint de transformación de imágenes | No: `imageService: "passthrough"` |
| `sharp` (alto) | Solo build / dev, no se ejecuta en Workers | CVE de libvips, libheif y librsvg | No: no se usa `astro:assets` |
| `wrangler`, `miniflare`, `undici`, `ws`, `@fastify/busboy` | Solo herramientas (deploy, `pages dev`, tests) | DoS, consumo de memoria e inyección de cabeceras en clientes HTTP y WebSocket de Node (no del Worker) | No llegan al Worker; sí corren en el CI y en la máquina de desarrollo |
| `vitest`, `tinypool`, `@vitest/mocker` (crítico) | Solo tests | `tinypool`: prototype pollution que llega a ejecución de código mediante las opciones del worker; `@vitest/mocker`: lectura de archivos y code injection por mocks | No llegan a producción. Aplican a quien controle los tests o las opciones del pool, y el CI solo corre código del propio repo; aun así es el "crítico" del reporte |
| `drizzle-kit`, `esbuild`, `@esbuild-kit/*`, `tailwindcss`, `postcss-*` | Solo build / herramientas | Moderados: el dev server de esbuild acepta requests de cualquier sitio; `postcss-selector-parser`: CPU cuadrática con selectores propios | No en CI ni en producción |

### 1.1 Exposición real de Astro (verificada en el código)

- Sin `define:vars`, `set:html`, props en spread (`{...x}`), `slot="..."`, `server:defer` ni `transition:*` (las apariciones de `transition:` son declaraciones CSS).
- `imageService: "passthrough"` y sin `astro:assets`: el RCE de AVIF y las imágenes de `sharp` no se ejecutan.
- Sin `base` configurada: no aplica el bypass de segmentos de ruta.
- Queda sin descartar el SSRF por `Host`, que depende de cómo Cloudflare Pages sirve la página de error. Hay que verificarlo contra la versión corregida, no asumirlo.

Conclusión: **la urgencia es media, no crítica**. Hoy no hay una ruta de explotación conocida, pero hay dos "críticos" en el reporte (`astro` y `tinypool`) y conviene cerrarlos antes de abrir la app a todo el mundo. Los arreglos de Astro solo salen en la 7.x (`<7.2.8` para el RCE de imágenes).

## 2. Objetivos y no objetivos

**Objetivos**

1. `npm audit --omit=dev` queda en 0 vulnerabilidades altas o críticas, y `npm audit` completo en 0 críticas.
2. Ningún cambio de comportamiento visible: mismas rutas, mismas respuestas de API, mismo aspecto.
3. Cada etapa se puede desplegar y revertir por separado.
4. La suite actual (unitarias, integración, cobertura y E2E) pasa sin bajar umbrales ni omitir tests.

**No objetivos**

- Rediseñar estilos ni migrar a nuevas funciones de Astro 6/7 que no hagan falta.
- Subir dependencias que `npm audit` no marca (React, Arctic, TypeScript).
- Cambiar el modelo de despliegue (sigue siendo subida directa a Pages desde GitHub Actions).

## 3. Decisiones

**D1. Tres etapas, de menor a mayor riesgo, en PRs separados.** Una sola subida con `--force` mezcla cuatro migraciones y, si algo falla, no se sabe cuál. Alternativa descartada: todo en un PR (diagnóstico imposible).

**D2. Etapa 1: `drizzle-orm` a 0.45.x (y `drizzle-kit` a 0.31.x).** Es la única subida de runtime que no cambia de framework y cierra el único advisory que toca la base. Se verifica con la suite de integración contra D1 real de Miniflare y con `npm run db:generate`, que no debe producir migraciones nuevas (el esquema no cambia). Si `drizzle-kit` quiere regenerar archivos, es señal de un cambio de formato y se corta la etapa.

**D3. Etapa 2: herramientas (`wrangler` 4, `miniflare` 4, `vitest` y `@vitest/coverage-v8` 5, `@playwright/test` si hace falta).** No cambia el código desplegado, pero sí cómo se prueba y se despliega: el CI y `deploy.yml` usan `wrangler`. Riesgos: cambios en el formato del ledger de migraciones de D1, en `wrangler pages deploy` y en las APIs de `miniflare` que usan `tests/helpers`. Se valida con la suite completa y con un `wrangler d1 migrations apply --local` sobre una base nueva y sobre una con datos. Esta etapa va antes que la 3 para que Astro 7 se pruebe con el tooling nuevo.

**D4. Etapa 3: `astro` 7, `@astrojs/cloudflare` 14, `@astrojs/react` 7 y Tailwind 4.**
- `@astrojs/tailwind` está obsoleta: Tailwind 4 se integra con `@tailwindcss/vite`, y `tailwind.config.mjs` pasa a configurarse en CSS (`@theme`). Hay que migrar `global.css` (hoy usa `@tailwind base/components/utilities`) y los tokens `primary-*`.
- `astro` 7 exige Node ≥ 22.23.4: `ci.yml`/`test-suite.yml`/`deploy.yml` usan Node 22 (sin fijar menor), hay que fijar una versión que cumpla y revisar `engines`.
- El alias `react-dom/server` → `react-dom/server.edge` de `astro.config.mjs` y `platformProxy` se revalidan: son los puntos donde un cambio de adaptador rompe el Worker.
- `@astrojs/react` 7 pide el peer `oxc-transform-react`: confirmar si es obligatorio o opcional.
- Cada salto mayor (5 → 6 → 7) se sigue con su guía de migración oficial, un salto por commit, para poder bisectar.

**D5. Un test de humo del bundle desplegable antes de cada release.** Además del E2E contra `wrangler pages dev`, la etapa 3 agrega al CI un build en modo producción y la comprobación de que `dist/_worker.js` arranca y responde `GET /api/health` (sin sync todavía: se acepta 503, ver `docs/13`). Es lo que detecta un Worker que compila pero no arranca.

**D6. Nada de `npm audit fix --force` ni de subir rangos a ciegas.** Se editan los rangos de `package.json` a mano, etapa por etapa, y se versiona el `package-lock.json` resultante. Alternativa descartada: Dependabot automático, porque abre PRs mayores sin la verificación de §4 y satura el CI.

**D7. Si una etapa no pasa la suite, no se adapta el test: se revierte o se corrige el código.** Los umbrales de cobertura no se tocan.

## 4. Estrategia de tests (test primero)

La suite ya existe y cubre el comportamiento que no debe cambiar. El trabajo de tests es **cerrar los huecos que la migración podría esconder**, antes de subir nada:

| Etapa | Rojo primero | Qué demuestra |
| --- | --- | --- |
| 1 | Test que ejecuta `db:generate` contra un directorio temporal y falla si produce migraciones nuevas | Que `drizzle-orm`/`drizzle-kit` no cambian el SQL ni el esquema |
| 2 | `tests/helpers` ejecutado con `miniflare` 4 en un test de humo propio (abrir D1 y KV, escribir y leer) | Que el entorno de test sigue siendo equivalente |
| 3 | E2E de cabecera: `/`, `/login`, `/privacidad`, `/terminos`, un 404 y una ruta protegida redirigiendo; contenido de `<head>` (título, canonical) | Que el HTML renderizado por Astro 7 no cambió |
| 3 | Smoke del Worker construido (D5) | Que `dist/_worker.js` arranca |
| 3 | Test visual manual de las páginas principales en escritorio y móvil | Que Tailwind 4 no cambió el aspecto (no hay test automático visual hoy) |

Verde: la suite completa (`npm run check`) y `npm audit` con el objetivo del §2. Refactor: eliminar los alias, polyfills y `@tailwind` directives que queden sin uso.

## 5. Despliegue y rollback

- Las tres etapas no tocan el esquema de D1 ni agregan variables de entorno: **sin migraciones**.
- Cada etapa llega a producción por el flujo normal (PR a `development`, release a `main`). Conviene un release por etapa para poder revertir a la anterior.
- Rollback: volver al deployment previo en Cloudflare Pages. El lockfile revertido en git restaura las versiones.
- Después de cada release: `GET /api/health`, login de prueba, agregar un partido a un calendario y un sync manual (`POST /api/admin/sync`).
- El primer deploy real tras la etapa 3 es el momento más riesgoso. No debe coincidir con el envío a verificación de Google ni con el Release A del cifrado de tokens (`docs/15`): primero uno, se verifica, después el otro.

## 6. Plan de implementación

1. **Etapa 1 (`chore/actualiza-drizzle`).** Test del diff de esquema en rojo; subir `drizzle-orm` y `drizzle-kit`; suite verde; `npm audit` sin el alto de drizzle.
2. **Etapa 2 (`chore/actualiza-herramientas`).** Smoke de `miniflare` 4; subir `wrangler`, `miniflare`, `vitest` y `@vitest/coverage-v8`; ajustar `vitest.config.ts` y `tests/helpers` si hace falta; verificar `deploy.yml` en seco (sin desplegar) y `db:migrate:local`.
3. **Etapa 3a (`chore/actualiza-astro`).** Smoke del Worker y E2E de cabecera en rojo sobre Astro 5 (deben pasar ya, sirven de línea base); subir Astro 5 → 6 y después 6 → 7, con `@astrojs/cloudflare` y `@astrojs/react`; fijar Node en los workflows.
4. **Etapa 3b (`chore/migra-tailwind-4`).** Separada de 3a para aislar un cambio visual de uno de framework.
5. Cada etapa: actualizar este documento con los desvíos, y `docs/13-testing-y-release.md` si cambia el tooling.

## 7. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| El Worker compila pero no arranca en Pages (cambio de adaptador) | Smoke D5 en el CI y verificación manual tras el primer deploy; rollback al deployment previo |
| Tailwind 4 cambia el aspecto (reset, valores por defecto) | Etapa separada (3b), revisión visual en escritorio y móvil, sin mezclar con 3a |
| `wrangler` 4 cambia el comportamiento de migraciones o de `pages deploy` | Etapa 2 sola, `db:migrate:local` sobre base nueva y con datos, deploy en seco |
| Node del CI inferior al que pide Astro 7 | Fijar versión en los tres workflows y probar el CI en el PR |
| Las dependencias vuelven a quedar viejas | Revisar `npm audit` en el checklist de release; evaluar Dependabot solo para parches y menores |
| `ws`/`undici` dentro de `miniflare` siguen marcados tras la etapa 2 | Se aceptan si no llegan al Worker, con la justificación escrita en las notas de implementación |

## 8. Notas de implementación

### Etapa 1: `drizzle-orm` 0.45 y `drizzle-kit` 0.31 (rama `chore/actualiza-drizzle`)

- **Versiones:** `drizzle-orm` 0.36 → 0.45.4 y `drizzle-kit` 0.28 → 0.31.11. `npm audit` baja de 22 a 21 vulnerabilidades: sale el alto de drizzle (GHSA-gpj5-g38j-94v9). Lo que queda corresponde a las etapas 2 y 3.
- **Desvío en el test del §4.** El criterio "`db:generate` no produce migraciones nuevas" ya no se cumplía **antes** de subir nada: `drizzle/migrations/meta` solo tiene el snapshot de la 0000 (el journal la registra como `0000_spotty_blacklash`) y las migraciones 0001 a 0008 se escribieron a mano. Por eso `drizzle-kit generate` produce una 0001 con todo lo agregado después (`league_teams`, `sessions`, `sync_runs`, `user_preferences`, columnas de `calendar_syncs`). Si se aplicara, fallaría con tablas duplicadas.
- **Test que lo reemplaza:** `tests/integration/db/esquema-drizzle.test.ts` genera el esquema completo desde `drizzle/schema.ts` en un directorio vacío y lo compara con `tests/integration/db/__snapshots__/esquema-drizzle.sql`. El snapshot se generó con 0.28 en un commit previo a la subida y pasa sin cambios con 0.31: el SQL es idéntico.
- 0.31 no pide actualizar el formato de los snapshots existentes (`drizzle-kit up` no hace falta).
- **Pendiente (fuera de esta etapa):** **no usar `npm run db:generate`** para las próximas migraciones hasta realinear el snapshot de drizzle con la 0008. Mientras tanto, seguir escribiendo las migraciones a mano como hasta ahora.
