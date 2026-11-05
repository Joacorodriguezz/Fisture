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
- Sync diario: ~9 invocaciones (docs/22 D4), ~45.000 filas leídas y ~2.000 escritas en un día normal
  (solo escribe lo que cambia); el primer sync después de sumar competencias escribe ~20.000.
- Bots y crawlers: se suman ~3.000 requests/día (sitemap con ~1.500 URLs, más buscadores e IA).

## 2. Tabla

| Recurso (tope Free) | Medido (oct-2026) | 100 usuarios | 1.000 usuarios | 10.000 usuarios |
| --- | --- | --- | --- | --- |
| Requests a Workers/Functions (100.000/día) | a medir (dashboard) | ~3.600 | ~9.000 | ~63.000 ⚠ |
| CPU por request (10 ms) | OK salvo el sync completo | OK | OK | OK |
| Subrequests por invocación (50) | El sync completo ya no entra: por lotes | — | — | — |
| D1 filas leídas (5 M/día) | 90 k–226 k/día | ~0,6 M | ~1,4 M | ~9,5 M ❌ |
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
- El límite de tasa (docs/16) escribe una fila en D1 por request limitada (login, callback, mutaciones, fallos de admin): con 500 usuarios activos por día son unas 50.000 filas, la mitad del tope. `/api/admin/status` informa `rateLimit.filas` y los `hits` por bucket para vigilarlo.
- Antes de eso, lo más barato es bajar lecturas: cachear en KV los listados públicos de `/hoy` y `/partidos`
  (iguales para todos los anónimos) con vencimiento corto.

## 4. Avisos de uso

A verificar en el dashboard si el plan Free ofrece notificaciones de uso para Workers y D1. Mientras tanto, revisar
**Workers & Pages → Overview** (requests) y **D1 → fisture-db → Metrics** (filas leídas/escritas) una vez por
semana hasta el lanzamiento. `monitor.yml` avisa si la app deja de responder, pero no anticipa un tope.
