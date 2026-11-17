# TDD: Caché del HTML público para no agotar la CPU del plan Free

Estado: aprobado para implementar (16/11/2026).

## 1. Contexto y problema

El 15/11/2026, entre las 00:00 y las 04:00 UTC, producción cortó 557 invocaciones con `exceededResources`
(error 1102, CPU del Worker excedida; cerca del 9 % de las requests del día). Medido con la API de
analytics de Cloudflare (`pagesFunctionsInvocationsAdaptiveGroups` y `httpRequestsAdaptiveGroups`):

- Los 503 que registra la zona (500, dato muestreado) fueron todos a ClaudeBot, que rastreó `/equipos/<slug>`
  a 400–650 requests por hora justo después del backfill de nombres en URLs (00:32 UTC). Cada URL se pidió
  unas 3 veces en la ventana.
- El 16/11 el mismo crawler volvió con ~1.900 requests entre 01:00 y 04:00 UTC y todas dieron 200. El corte
  no es determinístico: Free tolera ráfagas y corta cuando se acumulan requests pesadas (igual que en
  `docs/26`, notas de implementación).
- Causa de fondo: una página SSR gasta más que los 10 ms de CPU del plan Free. En horas de tráfico normal
  la mediana está entre 15 y 30 ms y el p99 entre 50 y 120 ms. `docs/24` decía "OK salvo el sync completo".
- Todo el HTML sale como `dynamic`: cada request, aunque sea anónima e idéntica a la anterior, ejecuta el
  render completo y sus consultas a D1.
- D1 (0,72 M filas leídas ese día), requests (~6.000) y KV quedaron lejos de sus topes.

Hoy le tocó a un bot; un pico de usuarios reales sobre las mismas páginas tendría el mismo efecto.

## 2. Objetivos y no objetivos

Objetivos:

- Que una request anónima repetida a `/equipos/[id]`, `/ligas/[id]` y `/partidos/[id]` no vuelva a
  renderizar ni a tocar D1 durante una ventana corta.
- Que un usuario con sesión nunca reciba HTML cacheado, ni su HTML quede guardado.
- Que un deploy no sirva HTML viejo que apunte a assets que ya no existen.
- Corregir `docs/24` con lo medido.

No objetivos:

- Bajar la CPU del render en sí (perfilado de la página de equipo): queda como seguimiento.
- Cachear `/`, `/hoy`, `/partidos`, los índices, las 404 o las 301 de id a slug.
- `Crawl-delay` en `robots.txt` o reglas de WAF para bots: afectan el rastreo (SEO) y se deciden aparte.
- Pasar a Workers Paid.
- El primer pedido de cada URL sigue costando un render: un barrido de URLs distintas solo mejora en las
  repeticiones (en el incidente, unas 2 de cada 3 requests).

## 3. Decisiones

**D1. Cache API (`caches.default`) dentro del middleware, no una Cache Rule de la zona.**
Una Cache Rule evitaría incluso invocar el Worker, pero su configuración vive fuera del repo, la condición
"sin cookie de sesión" quedaría en una expresión del dashboard sin tests, y no permite versionar la clave
por deploy (la documentación de Pages advierte que puede servir contenido viejo tras un deploy). Con la
Cache API el Worker corre igual, pero un acierto no renderiza ni consulta D1: su costo de CPU es el de las
requests livianas que ya se miden en 2–4 ms. La Cache API funciona en Pages Functions tanto en dominio
propio como en `*.pages.dev` (documentación de Workers, "Cache"). Es por datacenter y no usa Tiered Cache:
alcanza, porque un crawler entra por pocos datacenters.

**D2. Rutas y TTL.** Solo `GET` a `/equipos/<x>` (excluida `/equipos/buscar`), `/ligas/<x>` y
`/partidos/<x>`, con un TTL de 900 s (15 minutos) en una tabla de políticas por ruta. Los datos cambian con
el sync diario; 15 minutos acotan el desfase de los textos relativos a la fecha (folio, "próximo partido").

**D3. Quién saltea la caché.** Cualquier request con cookie `session` (válida o no), cualquier método que no
sea `GET`, y cualquier query string con parámetros fuera de la lista permitida de la ruta (`lado` en
equipos; ninguno en ligas y partidos). Saltear, en vez de normalizar, evita servir un HTML cuyo enlace de
login (`next=`) no coincide con la URL pedida.

**D4. Qué respuestas se guardan.** Solo estado 200, `Content-Type` `text/html` y sin `Set-Cookie`. Las 404
(rewrite) y las 301 no se guardan.

**D5. Clave versionada por deploy.** La clave es la URL más un identificador de build (`__BUILD_ID__`,
definido en `astro.config.mjs` con `GITHUB_SHA` o, si falta, la hora del build). Un deploy nuevo empieza con
la caché vacía y las entradas viejas vencen solas.

**D6. Headers.** La copia guardada lleva `Cache-Control: public, s-maxage=900`. La respuesta que recibe el
cliente (acierto o no) lleva `Cache-Control: public, max-age=0, must-revalidate`, para que el navegador no
guarde el HTML anónimo y lo muestre después de iniciar sesión, y `x-fisture-cache: HIT | MISS`. Las
respuestas que saltean la caché no cambian.

**D7. Lugar en el middleware.** `sequence(seguridad, dominio, cache, sesion)`: después de la redirección al
dominio canónico y antes de cargar la sesión (un acierto no toca D1). Queda dentro de `seguridad`, así los
headers de seguridad y la CSP se agregan en cada respuesta y no quedan congelados en la copia.

**D8. La caché nunca rompe una página.** Si `caches` no existe (por ejemplo en `astro dev`) o `match`/`put`
fallan, se sirve el render normal. El `put` va en `waitUntil`. Apagado sin tocar código: variable
`HTML_CACHE=off` (rige tras un deploy) y, para vaciarla ya, "Purge Everything" de la zona.

Alternativas descartadas: Cache Rule (D1); Workers Paid (USD 5/mes, resuelve la CPU sin código, pero no
baja lecturas de D1 y es una decisión de costo aparte); prerender estático (el fixture cambia a diario y hay
~1.500 URLs).

## 4. Estrategia de tests

Test primero (rojo, verde, refactor). La lógica vive en `src/lib/cache-publico.ts`, sin depender de Astro,
y se prueba con una caché falsa (un `Map`) y un `next` espía.

Unitarios (`tests/unit/cache/cache-publico.test.ts`):

- Política por ruta: las tres rutas dan TTL; `/equipos/buscar`, `/equipos`, `/hoy`, `/api/...` y `/` no.
- Salteo: cookie `session` presente; método distinto de `GET`; parámetro de query no permitido;
  `HTML_CACHE=off`; `caches` inexistente.
- Clave: incluye el build id; `?lado=local` y sin query son claves distintas; dos builds, claves distintas.
- Primer pedido: llama a `next`, responde `MISS`, guarda una copia con `s-maxage=900`.
- Segundo pedido: no llama a `next`, responde `HIT` con el mismo cuerpo.
- No guarda: estado 404, 301, 500; respuesta con `Set-Cookie`; `Content-Type` que no es HTML.
- `match` o `put` que tiran: se sirve el render y no se propaga el error.
- La respuesta al cliente lleva `max-age=0, must-revalidate` y la guardada no lleva `Set-Cookie`.

E2E (Playwright, `tests/e2e/`): dos `GET` anónimos a una página de equipo, el segundo con
`x-fisture-cache: HIT` y con los headers de seguridad; con cookie `session`, sin ese header. Si el servidor
de E2E no expone la Cache API, se informa y queda cubierto por los unitarios.

`src/lib/cache-publico.ts` se suma a `coverage.include` de `vitest.config.ts`.

## 5. Plan de implementación

1. Tests unitarios de `cache-publico` (rojo).
2. `src/lib/cache-publico.ts`: tabla de políticas, `claveDeCache`, y `servirConCache(entrada, next)` con la
   caché, `waitUntil`, el build id y el interruptor inyectados (verde).
3. `__BUILD_ID__` en `astro.config.mjs` (`vite.define`) y su declaración de tipo; `HTML_CACHE` en
   `src/env.d.ts`.
4. Middleware `cache` en `src/middleware.ts`, en el orden de D7.
5. E2E y `coverage.include`.
6. Documentación: fila de CPU y nota del incidente en `docs/24`; línea en `CLAUDE.md` (Observabilidad);
   notas de implementación de este TDD.

## 6. Despliegue y rollback

- Sin migraciones ni secrets nuevos. `HTML_CACHE` es opcional (ausente = prendida).
- Verificación en staging y producción: `curl -sI https://fisture.com/equipos/<slug>` dos veces; la segunda
  debe traer `x-fisture-cache: HIT`. Con `-H "Cookie: session=x"`, sin ese header.
- Una semana después: comparar en analytics `exceededResources`, la mediana de CPU y las lecturas de D1.
- Rollback: `HTML_CACHE=off` y redeploy, o revertir el PR. Para vaciar la caché sin deploy, "Purge
  Everything" de la zona.

## 7. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Servir HTML de un usuario a otro | Solo se guarda sin cookie `session` y sin `Set-Cookie` (D3, D4), con tests |
| HTML viejo tras un deploy apuntando a assets inexistentes | Clave con build id (D5) |
| Datos desfasados hasta 15 minutos tras el sync | Aceptado: el sync es diario; el TTL está en una tabla |
| El usuario cierra sesión y ve la página anónima cacheada | Es el contenido correcto para un anónimo |
| Un barrido de URLs distintas sigue costando un render por URL | Fuera de alcance (no objetivos); seguimiento: perfilar el render o Workers Paid |
| La Cache API no está disponible en algún entorno | D8: se sirve el render normal |

## 8. Notas de implementación

Implementado el 16/11/2026, pasos 1 a 6. Desvíos y detalles respecto del diseño:

- La clave es la URL pedida más el parámetro `__build=<id>` (la Cache API exige una URL como clave).
- `servirConCache` recibe un `onError(operacion, error)` opcional; el middleware lo conecta a `rootLogger.warn` (solo se loguean fallos de `match`/`put`, no los aciertos). `__BUILD_ID__` se lee con `typeof` y vale `"dev"` si no está definido.
- Una respuesta no cacheable (404, 301, 500, con `Set-Cookie`, no HTML) sale tal cual, sin `x-fisture-cache` ni el `Cache-Control` de D6; D6 aplica solo a HIT y MISS.
- El E2E corre en el servidor local de Pages (`wrangler pages dev`), que sí expone la Cache API: `tests/e2e/cache-html.spec.ts` verifica MISS, HIT con headers de seguridad, cookie `session` sin caché, 404 y query no permitida. El HIT se espera con `expect.poll` porque el `put` va en `waitUntil`.
- Tests: `tests/unit/cache/cache-publico.test.ts` (35 casos). `src/lib/cache-publico.ts` entra en `coverage.include`.
- Pendiente: verificación con `curl` en staging y producción tras el deploy, y la comparación de analytics a la semana (§6).
