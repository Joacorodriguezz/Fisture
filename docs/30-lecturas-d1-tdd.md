# TDD: Bajar las lecturas de D1 del sync

Fecha: 8 de noviembre de 2026. Origen: el 6/11 la cuenta superó el límite gratuito de 5 M filas leídas por día (code 7500). Producción devolvió 500 en las páginas con datos hasta las 00:00 UTC.

## 1. Contexto y problema

Medición con `wrangler d1 insights --timePeriod 7d --sort-by reads` (60 consultas más caras, 1–8/11):

| Base | Total 7 días | Chequeos de consistencia | Sync de competencias | Páginas y resto |
|---|---|---|---|---|
| `fisture-db` (producción) | 5,58 M | 2,59 M (46 %) | 2,06 M (37 %) | 0,93 M (17 %) |
| `fisture-staging` | 15,18 M | 9,06 M (60 %) | 6,03 M (40 %) | 0,09 M (< 1 %) |

**Las páginas no son el problema.** Casi todas las lecturas salen del sync de competencias y de lo que corre al final de cada lote. La hipótesis inicial, que la auditoría mobile contra staging había agotado la cuota, explica muy poco: todas las páginas de staging sumaron 89 k filas en la semana.

Causas, de mayor a menor:

1. **Los chequeos de consistencia corren en cada lote.** `runSync` llama a `checkConsistency` al final de cada `POST /api/admin/sync`. Un barrido completo tiene unos 10 lotes (47 competencias de a 5), así que los ocho chequeos se repiten unas 10 veces por barrido. Varios recorren `matches` entera:

   | Chequeo | Filas por ejecución |
   |---|---|
   | `empty_league` | ~21.000 |
   | `match_missing_team` | ~11.800 |
   | `duplicate_match` | ~7.700 |
   | `finished_without_score` | ~3.900 |
   | `match_same_team` | ~3.800 |
   | `stale_scheduled` | ~2.300 |

   `empty_league` es el más caro porque `matches` no tiene índice por `league_id`: el `NOT EXISTS` recorre la tabla una vez por competencia.
2. **`syncPartidos` recorre `matches` entera para cada competencia.** `WHERE league_id = ? AND source = ?` no tiene índice y lee unas 3.900 filas para devolver un promedio de 85. En producción fueron 1,17 M filas en 304 llamadas.
3. **`equiposConocidos` se recalcula para cada competencia.** El `DISTINCT` sobre `league_teams ⨝ leagues ⨝ teams` lee unas 2.700 filas por llamada (693 k en producción en la semana).
4. **Staging resincroniza en cada push a `development`.** Cada PR mergeado dispara un barrido completo, de 1 M a 1,5 M de filas. El 6/11 hubo cuatro pushes (#68, #69, dos actualizaciones de rama y #70) más el sync diario de producción. Producción y staging comparten la cuota de la cuenta.

`docs/24` estimaba unas 150 filas por página SSR y no contaba el sync ni staging.

## 2. Objetivos y no objetivos

**Objetivos**

- Un barrido completo del sync lee al menos 5 veces menos filas que hoy.
- Los chequeos de consistencia corren una vez por barrido y siguen detectando lo mismo.
- Staging deja de resincronizar en cada push cuando el cambio no lo necesita.
- Un test falla si una consulta caliente vuelve a recorrer la tabla entera (`EXPLAIN QUERY PLAN`).

**No objetivos**

- Cachear en KV las páginas públicas (`docs/24` §5). Hoy son el 17 % en producción. Se puede hacer después.
- Pasar a Workers Paid.
- Cambiar qué detectan los chequeos o qué datos guarda el sync.
- Optimizar `teams WHERE source = ?` (485 filas por llamada). Devuelve todas las filas que lee, así que solo se arregla con caché, y su impacto es bajo (183 k en la semana).

## 3. Decisiones

1. **Chequeos de consistencia solo al cerrar el barrido.** Corren cuando el pedido no es por lotes (`syncAllLeagues`, una competencia suelta) o cuando es el último lote (`siguienteLote === null`). Los lotes intermedios guardan `issues: []`. Los chequeos miran la base entera, no el lote, así que correrlos 10 veces seguidas repite el mismo resultado. Alternativa descartada: correrlos cada N lotes; agrega estado sin dar más información. Efecto en la salud: `/api/health` mira el último run. El último lote es el que queda último, así que los hallazgos siguen visibles.
2. **Índice `idx_matches_league_source` en `matches(league_id, source)`.** Sirve a `syncPartidos` (igualdad en las dos columnas) y a `empty_league` (prefijo `league_id`). Migración `0014`, solo `CREATE INDEX IF NOT EXISTS`. Costo: una escritura más de índice por partido nuevo o actualizado. Hoy son unos 400 por día, frente a 100 k de cuota de escrituras. Alternativa descartada: reescribir `empty_league` con `GROUP BY`. Igual recorre `matches` una vez, y el índice además arregla `syncPartidos`.
3. **`equiposConocidos` se calcula una vez por invocación y fuente.** Se guarda en un `Map` dentro de `syncLeagues`. Se invalida después de sincronizar una competencia destacada, porque esa sincronización puede sumar equipos a `league_teams`. Así una copa del mismo lote ve los equipos recién cargados por su liga, igual que hoy. Alternativa descartada: guardarlo en KV entre invocaciones; agrega una invalidación entre requests por 700 k filas semanales.
4. **Staging sincroniza en el push solo si cambia algo que afecta los datos.** El job `sync` de `staging.yml` corre siempre en `schedule` y en `workflow_dispatch`. En `push` corre solo si el commit toca `src/lib/data-providers/**`, `drizzle/migrations/**` o `src/lib/observability/consistency.ts`, según `git diff --name-only HEAD^ HEAD`. Los merges a `development` son squash, así que es un solo commit. Sin sync, el smoke de solo lectura corre igual. Alternativa descartada: no sincronizar nunca en el push; un cambio en el sync se probaría recién al día siguiente.
5. **Guardia de planes de consulta.** Un test de integración corre `EXPLAIN QUERY PLAN` sobre la D1 efímera para las consultas calientes. Falla si aparece `SCAN matches` sin índice: `syncPartidos`, `empty_league`, partidos de un equipo, partidos de un rango y conteo por día. Es la forma barata de que esto no vuelva sin que nadie lo note.

## 4. Estrategia de tests

Primero en rojo:

- **`run-sync`:** con `lote` intermedio no se llama a `checkConsistency` y el run queda sin issues. Con el último lote, o sin `lote`, se llama una vez.
- **Planes (`tests/integration/planes-de-consulta.test.ts`, nuevo):** las consultas de la decisión 5 usan un índice, sin `SCAN matches`. En rojo para `syncPartidos` y `empty_league` hasta la migración `0014`.
- **`sync`:** en un lote con dos copas no destacadas de la misma fuente, `equiposConocidos` hace una sola consulta. Se cuentan los `SELECT DISTINCT` con un espía sobre `env.DB.prepare`. Si una liga destacada del mismo lote suma un equipo, la copa siguiente lo ve.
- **Regresión:** los tests actuales de consistencia, sync y salud pasan sin cambios.
- **Workflow:** se revisa a mano (no hay tests de workflows). El primer push después del merge no debería sincronizar, porque este PR toca `data-providers` y `migrations`, así que este primero sí sincroniza. Se verifica en el push siguiente.

## 5. Plan de implementación

1. Tests en rojo.
2. `run-sync.ts`: decidir si corre `checkConsistency` según el lote.
3. Migración `0014_matches_league_source_idx.sql` e índice en `drizzle/schema.ts`.
4. `sync.ts`: caché de `equiposConocidos` por invocación.
5. `staging.yml`: condición del job `sync` en el push.
6. `docs/24`: corregir la estimación (el sync domina, no las páginas). `docs/26`: cuándo sincroniza staging.
7. Verde, `npm run check`, notas de implementación.
8. Después del deploy: comparar `wrangler d1 insights --timePeriod 1d` del día siguiente contra esta medición.

## 6. Despliegue y rollback

- **Migración D1** `0014` (solo un índice nuevo). Se aplica sola en `staging.yml` y en `deploy.yml`. Crear el índice lee `matches` una vez (~4 k filas).
- Sin variables de entorno ni cambios de API.
- Rollback: revertir el commit. El índice puede quedar; no molesta. Si hiciera falta, `DROP INDEX idx_matches_league_source`.

## 7. Riesgos

- **Un problema de datos que aparece y desaparece dentro del mismo barrido ya no queda registrado en un lote intermedio.** Aceptable: lo que importa es el estado al final del barrido.
- **Si el barrido se corta antes del último lote, ese día no hay chequeos.** `sync-cron.yml` ya abre un incidente cuando falla un lote, y `keepalive.yml` avisa si pasan 72 h sin un sync bueno.
- **El filtro de paths de staging deja pasar un cambio que sí afecta datos** (por ejemplo, en `lib/db`). Mitigación: `workflow_dispatch` y el sync diario de las 9:30 UTC.
- **Planes distintos en D1 y en Miniflare.** Las dos usan SQLite y el mismo esquema. Se verifica en staging con `insights` después del deploy.

## 8. Notas de implementación

- **Tests en rojo verificados.** Antes del cambio fallaron los cinco nuevos:
  - El lote intermedio guardaba `empty_league`.
  - `syncPartidos` y `empty_league` daban `SCAN matches` y `SCAN m`.
  - Un lote de copas hacía 5 `select distinct` y el lote de la Libertadores, 3.
  
  Las consultas de páginas (partidos de un equipo, rango y conteo por día) ya usaban índices. Quedan en la guardia para que no retrocedan.
- **Guardia de planes en `tests/integration/db/planes-de-consulta.test.ts`.** Captura el SQL real que genera Drizzle, con sus parámetros, mediante un `Proxy` sobre `env.DB.prepare`, y corre `EXPLAIN QUERY PLAN` sobre esa misma sentencia. Así no depende de copiar el SQL a mano.
- **Lotes intermedios.** Guardan el run con `issues: []` y escriben en el log `consistency_skipped` con el número de lote, para que se vea que el salto fue a propósito.
- **Staging.** La decisión no se tomó a nivel de job sino con un paso `decidir` dentro del job `sync`: solo se saltea el paso del sync, y el smoke de solo lectura corre siempre. Cuando no sincroniza, lo anota en el resumen del run. Para un merge de «Update branch», `HEAD^` es el primer padre, así que también entra lo que trajo el merge.
- **Lotes de copas.** Los lotes 3 a 8 de `lotesDeSync()` son solo copas. Con la caché, cada uno hace una consulta de equipos conocidos en lugar de cinco.
- **Documentación.** Se actualizaron `CLAUDE.md` (dónde corren los chequeos), `docs/24` (el sync domina las lecturas) y `docs/26` (cuándo sincroniza staging).
- **Pendiente después del deploy:** medir con `wrangler d1 insights --timePeriod 1d` (paso 8).
