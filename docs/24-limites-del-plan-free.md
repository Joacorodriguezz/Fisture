# Límites del plan Free contra el uso esperado

El incidente de KV (docs/20) mostró que un límite del plan Free se puede agotar con poco tráfico. Esta tabla
compara los topes con el uso medido y con una proyección, para saber cuándo pasar a Workers Paid (USD 5/mes).
Revisarla en cada release que cambie el patrón de consultas. Lo medido sale de docs/21 §1.2; lo marcado "a medir" hay que completarlo con el dashboard.

## 1. Supuestos de la proyección

- Usuarios **activos por día**: 30 % de los registrados.
- Cada activo genera **20 requests a Functions** por día (páginas SSR + llamadas a `/api/*`). Los assets
  estáticos de Pages (`/_astro/*`, imágenes) no cuentan como requests de Workers.
- Cada página SSR lee en promedio **~150 filas** de D1 (medido: listados de `/hoy` y `/partidos` son los más caros).
- Escrituras por activo: ~5 por día (sesión, seguir equipos, estados de `calendar_syncs`).
- Sync diario: ~9 invocaciones (docs/22 D4) y ~2.000 escritas en un día normal (solo escribe lo que
  cambia); el primer sync después de sumar competencias escribe ~20.000. **Lecturas: el sync domina.**
  La estimación anterior (~45.000 filas) no contaba los chequeos de consistencia. Medido en noviembre
  de 2026: cada barrido leía de 1 M a 1,5 M filas, porque los chequeos corrían en cada lote y las
  búsquedas por competencia recorrían `matches` entera. Con docs/30 corren una vez por barrido y hay
  índice. Staging comparte la cuota de la cuenta y antes resincronizaba en cada push a `development`:
  el 6/11 eso agotó los 5 M (docs/30 §1).
- Reconciliación de calendarios (docs/17): hasta 40 invocaciones por día más (una por lote de ~3 a 4 usuarios con trabajo, 45 subrequests cada una). Sumadas a las ~9 del sync de ligas siguen muy por debajo de las 100.000 requests diarias.
- Bots y crawlers: se suman ~3.000 requests/día (sitemap con ~1.500 URLs, más buscadores e IA).

## 2. Tabla

| Recurso (tope Free) | Medido (oct-2026) | 100 usuarios | 1.000 usuarios | 10.000 usuarios |
| --- | --- | --- | --- | --- |
| Requests a Workers/Functions (100.000/día) | a medir (dashboard) | ~3.600 | ~9.000 | ~63.000 ⚠ |
| CPU por request (10 ms) | OK salvo el sync completo | OK | OK | OK |
| Subrequests por invocación (50) | El sync completo ya no entra: por lotes | — | — | — |
| D1 filas leídas (5 M/día) | ~0,8 M/día en producción y hasta ~2 M/día más en staging (nov-2026, antes de docs/30) | ~0,6 M | ~1,4 M | ~9,5 M ❌ |
| D1 filas escritas (100 k/día) | < 300/día (20 k el día de carga) | ~2.200 | ~3.500 | ~17.000 |
| D1 almacenamiento (5 GB) | a medir (`wrangler d1 info fisture-db`) | < 100 MB | < 200 MB | < 1 GB |
| KV escrituras (1.000/día) | ~0 desde docs/20 y docs/21 | ~0 | ~0 | ~0 |
| KV lecturas (100.000/día) | a medir | OK | OK | OK |
| GitHub Actions | gratis (repo público) | — | — | — |
| ESPN (sin cuota publicada) | ~90 pedidos/día | igual | igual | igual |
| football-data / API-Football | no se usan en `LEAGUES_CONFIG` | — | — | — |

⚠ = a menos de 2× del tope. ❌ = supera el tope.

## 3. Umbrales y decisión

- **Pasar a Workers Paid** cuando se cumpla cualquiera: más de **3.000 usuarios registrados**, lecturas de D1
  sostenidas por encima de **2,5 M/día** (50 %), o requests por encima de **50.000/día**. Paid sube D1 a 25.000 M
  filas leídas/mes, 50 M escritas/mes y 1.000 subrequests por invocación (el sync podría volver a una sola
  invocación). Al pasar: actualizar `/privacidad` (Time Travel de 30 días, docs/14) y esta tabla.
- El límite de tasa (docs/16) escribe una fila en D1 por request contada (login, callback, mutaciones autenticadas, `calendario/sync`, fallos de admin), con un tope de `limit + 1` por sujeto y ventana. Estimación de escrituras por día: uso normal ~20 por usuario activo (login y callback 2, mutaciones ~10 con IP y usuario, `calendario/sync` ~9 con sus 3 contadores), es decir ~10.000 con 500 usuarios activos, y ~50.000 si cada uno llega a ~100 hits (el escenario conservador de antes). Peor caso adversarial (docs/16 §12, R11): ≈ 5.200/día por IP anónima (~19 IP agotan las 100.000) y, con sesión, una cuenta que insista a ~3 mutaciones por segundo gasta la cuota sola. Si D1 se acerca al tope se apaga el limitador con `ratelimit:modo=off` (docs/23 §6). `/api/admin/status` informa `rateLimit.filas` y los `hits` por bucket para vigilarlo.
- Antes de eso, lo más barato es bajar lecturas: cachear en KV los listados públicos de `/hoy` y `/partidos`
  (iguales para todos los anónimos) con vencimiento corto.

## 4. Avisos de uso

A verificar en el dashboard si el plan Free ofrece notificaciones de uso para Workers y D1. Mientras tanto, revisar
**Workers & Pages → Overview** (requests) y **D1 → fisture-db → Metrics** (filas leídas/escritas) una vez por
semana hasta el lanzamiento. `monitor.yml` avisa si la app deja de responder, pero no anticipa un tope.

## 5. Filas leídas por la reconciliación de calendarios (docs/17)

Estimación, no medida. Cada lote evalúa `candidatos` (`calendar/reconcile.ts`): recorre `users` por
`calendar_reconciled_at` y, para cada usuario, dos `EXISTS` correlacionados, hasta juntar 10 con trabajo. Los
partidos ya están acotados por `m.date_time` (desde hace `HORAS_PARTIDO_JUGADO` en los eventos por corregir, desde
ahora en el auto-sync) y las columnas de equipo tienen índice (`idx_matches_home_team`, `idx_matches_away_team`).

Costo de evaluar a un usuario **sin trabajo** (se recorre completo, no corta antes):

- Sin auto-sync: sus `calendar_syncs` (~20 filas) y sus `user_teams` (~3): **~25 filas**.
- Con auto-sync: además, por equipo (~3), los partidos por local y por visitante (~50 por índice) y la comprobación
  de cada partido futuro (~30) contra `calendar_syncs`: **~450 filas**.
- Con 30 % de usuarios con auto-sync, el promedio es de unas **160 filas por usuario**.

Un usuario sin trabajo no se marca como atendido, así que queda delante en la cola y **se vuelve a evaluar en
cada lote del barrido** (y el lote final, vacío, evalúa a todos).

| Escenario (1.000 usuarios registrados) | Conectados | Con trabajo por día | Lotes | Filas leídas por día |
| --- | --- | --- | --- | --- |
| Esperado | 500 | 50 | ~15 | ~15 lotes x 450 usuarios x 160 filas + 500 x 160 = **~1,2 M** |
| Pesimista | 1.000 | 200 | 40 (tope) | 40 lotes x 800 usuarios x 160 filas = **~5,1 M** |

Contra el tope de 5 M diarias de D1 Free: el escenario esperado suma ~1,2 M a los ~1,4 M del resto (§2), unos
2,6 M, ya por encima del umbral de 2,5 M del §3. El pesimista lo supera por sí solo. **Con ~1.000 usuarios conectados
el costo de esta consulta es lo primero que hay que bajar**; opciones, de menor a mayor cambio: marcar como
atendido (o guardar `calendar_checked_at`) al usuario que se evaluó sin trabajo, para que no vuelva en el mismo
barrido; mantener una marca "tiene trabajo" al escribir `calendar_syncs`; pasar a Workers Paid. Hasta ~300
usuarios conectados el costo es de unas 0,4 M filas por día y no hace falta actuar. Medirlo con **D1 → Metrics**
(filas leídas) antes y después del primer barrido real.
