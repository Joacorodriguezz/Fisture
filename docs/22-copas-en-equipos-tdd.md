# TDD: Copas en el fixture de cada equipo, Brasileirão y sync por lotes

Estado: implementado (2026-11-03). El usuario pidió implementarlo sin revisión previa del diseño, así que
este documento registra el diseño y los desvíos a la vez.

## 1. Contexto y problema

El flujo esperado de la app es: *soy hincha de Estudiantes → entro a la Liga Profesional → abro
Estudiantes → veo todo lo que juega*: liga, Libertadores, Copa Argentina, Supercopa Internacional,
Trofeo de Campeones, etc. Hoy:

1. Solo se sincronizan 13 competencias. Faltan **todas las copas nacionales** (FA Cup, Carabao Cup,
   Copa del Rey, Coppa Italia, DFB-Pokal, Coupe de France, Copa Argentina, supercopas...), el
   **Brasileirão** y las copas de Brasil. El fixture de un equipo queda incompleto.
2. Las copas "de un partido" (Recopa, Supercopa de la UEFA) se listan en `/ligas` como si fueran una
   liga más. Para el usuario son ruido: nadie "entra" a la Recopa, quiere verla en su equipo.
3. Producción está en **Workers Free (50 subrequests por invocación)**. El sync completo ya hace
   ~26 pedidos a ESPN y ~90 consultas a D1 en una sola invocación; con ~43 competencias no entra.
4. Los equipos brasileños que entraron por la Libertadores quedaron con esa copa como "liga de origen"
   y sin país.

## 2. Objetivos y no objetivos

Objetivos:

- Sincronizar las copas nacionales e internacionales que juegan los equipos de las 7 ligas
  (las 5 grandes de Europa, Argentina y Brasil), y sumar el Brasileirão.
- Listar (en `/ligas`, filtros, búsqueda, sitemap y `llms.txt`) solo las **destacadas**: las ligas,
  Champions, Europa League, Conference League, Libertadores y Sudamericana.
- Que el resto aparezca **en el fixture de cada equipo** (página del equipo, `.ics`, sincronización
  de calendario, `/hoy` y `/partidos`), con el nombre de la competencia visible en cada partido.
- Que el sync diario entre en Workers Free.

No objetivos:

- Ligas de ascenso (Championship, Primera Nacional, Série B): sus equipos no son "conocidos".
- Amistosos (`club.friendly`, Emirates Cup, Joan Gamper): ESPN los carga tarde y sin sede confiable.
- Cambiar de proveedor de datos (ver tarjeta de derechos de uso de las fuentes).

## 3. Decisiones

**D1. Inventario sacado de ESPN, no de memoria.** Se recorrió `soccer/all/teams/{id}/schedule` para
todos los equipos de las 7 ligas (temporadas 2025, 2026 y fixture futuro) y se juntaron los slugs de
competencia. Así apareció, por ejemplo, `arg.supercopa.internacional` (la copa "rara" de Estudiantes) y
`arg.trofeo_de_la_campeones` (con ese slug, no `arg.trofeo_de_campeones`). Descartado: deducir slugs a
mano (varios responden 400 o con otro nombre).

**D2. `destacada` en la configuración y `leagues.is_featured` en D1.** `LEAGUES_CONFIG` declara cada
competencia con `destacada: boolean`; el sync lo copia a `leagues.is_featured` (migración `0009`,
aditiva, `DEFAULT 1`). Las páginas filtran por la columna. Descartado: filtrar por una lista de slugs en
cada página (repetido en 6 lugares y desincronizable con la base).

**D3. Una copa no destacada solo guarda partidos de equipos conocidos.** "Conocido" = participa de
alguna competencia destacada activa de la misma fuente (`league_teams` ⨝ `leagues.is_featured`). Se
guarda el partido y también al rival (para mostrar el cruce), pero ese rival no se ofrece para seguir
porque no juega ninguna destacada. Sin esto, la FA Cup y la Coupe de France cargarían cientos de partidos
entre clubes amateurs. Por eso el orden de `LEAGUES_CONFIG` es: ligas → copas destacadas → resto.

**D4. Sync por lotes de 5 competencias, un request por lote.** `POST /api/admin/sync {"lote": n}`
sincroniza `lotesDeSync()[n]` y responde `siguienteLote` (`null` en el último, que además desactiva las
competencias que salieron de la configuración). El workflow `sync-cron.yml` recorre los lotes. Cuenta
por lote: 5 × (2 pedidos a ESPN + ~6 consultas D1) + ~12 fijas del run ≈ 52 en el peor caso con un
reintento, ~42 normal; con 6 competencias ya no hay margen. Cada lote queda como un `sync_run`.
Descartado: Workers Paid (decisión operativa aparte, docs/20 D6) y un Durable Object/cola (más infraestructura
para un cron diario). Sin `lote` el endpoint sigue sincronizando todo (sirve en local y en `sync:check`).

**D5. Adopción de liga de origen.** Al sincronizar una **liga**, un equipo existente sin país (entró
por una copa) pasa a esa liga y toma su país. Corrige a los brasileños cargados por la Libertadores. Un
equipo con país no se toca (un descendido conserva su liga anterior).

**D6. `empty_league` ignora las no destacadas.** La FA Cup no tiene partidos de equipos de Premier hasta
la 3.ª ronda: avisar todo el año sería ruido en `/api/admin/status`.

**D7. No se activa la reconciliación de calendarios en el workflow.** `reconcileCalendars` hoy solo
corre desde `functions/scheduled.ts`, que Pages no ejecuta. Activarla desde el workflow parece natural,
pero su presupuesto (20 usuarios × 10 partidos) excede las 50 subrequests de Workers Free. Queda como
hallazgo para un TDD propio. **Resuelto en `docs/17`** (2026-11-03): lotes de usuarios con presupuesto de
subrequests y un job `calendarios` en `sync-cron.yml`.

## 4. Diseño

| Pieza | Cambio |
| --- | --- |
| `data-providers/types.ts` | 43 competencias con `destacada`; región `mundial`; `lotesDeSync`, `COMPETENCIAS_POR_LOTE` |
| `data-providers/espn.ts` | Etapas nuevas en español (rondas de copas, estaduales); `partirEtapa` genérico para `torneo---etapa` |
| `data-providers/sync.ts` | `is_featured`; `soloEquiposConocidos`; adopción de liga (D5); `syncLote` |
| `observability/run-sync.ts`, `api/admin/sync.ts` | opción `lote`, validación (400) y respuesta con `lote/totalLotes/siguienteLote` |
| `observability/consistency.ts` | D6 |
| `ligas/index.astro`, `equipos/buscar.astro`, `api/equipos/buscar.ts`, `db/queries.ts` (sitemap, llms) | solo destacadas |
| `equipos/[id].astro` | "Juega Liga · Libertadores · Copa Argentina..." y la competencia en cada partido |
| `sync-cron.yml` | recorre los lotes; un lote fallido no frena a los demás y el job termina en error |

## 5. Estrategia de tests

- Unit (`tests/unit/competencias.test.ts`): destacadas exactas, copas nacionales por país, orden
  ligas → destacadas → resto, sin duplicados, lotes completos y acotados, `partirEtapa`.
- Integración (`tests/integration/data-sync.test.ts`): copa no destacada guarda solo el cruce con un
  conocido (y su rival), no carga nada sin conocidos, `is_featured`, adopción de liga idempotente,
  `syncLote` (siguiente, último desactiva obsoletas, lote inválido).
- Endpoints: `admin.test.ts` (lote válido, 400), `run-sync.test.ts` (lote), `equipos.test.ts` (la
  búsqueda no ofrece rivales de copas ni equipos de competencias inactivas), `sitemap-llms.test.ts`,
  `consistency.test.ts` (D6).
- E2E: la copa no destacada no está en `/ligas` y sí en la página del equipo.
- Manual: `SYNC_TWICE=1 npm run sync:check` contra ESPN real: 43 competencias en 78 s, segunda pasada
  sin escrituras.

## 6. Despliegue y rollback

1. `deploy.yml` aplica la migración `0009` (aditiva) antes del deploy. Marca Recopa y Supercopa UEFA como
   no destacadas para que no se listen antes del primer sync.
2. El primer sync diario después del deploy carga las competencias nuevas lote por lote (~9 requests).
   Se puede adelantar con *Run workflow* en "Sync diario".
3. Rollback: volver al deployment anterior en Pages. El código viejo ignora `is_featured`; las copas
   nuevas quedarían listadas en `/ligas` hasta revertir también los datos
   (`UPDATE leagues SET is_active = 0 WHERE is_featured = 0`), lo que las oculta en ambas versiones.

## 7. Plan de implementación

1. Configuración + tests unitarios. 2. Migración y schema. 3. Sync (D3, D5) + tests de integración.
4. Lotes (D4) en servicio, `runSync`, endpoint y workflow. 5. Páginas y consultas. 6. `sync:check` real.

## 8. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| ESPN cambia o deja de responder un slug | Una competencia que falla no frena a las demás (errores por competencia, run `partial`) |
| Un lote supera 50 subrequests (muchos reintentos) | Margen calculado en D4; el workflow sigue con el siguiente lote y termina en error |
| Más filas leídas en D1 | ~5.000 partidos más; muy por debajo de 5 M filas/día (docs/21 §1.2) |
| Rivales amateurs con nombres repetidos | Se distinguen por id; no se ofrecen en la búsqueda |

## 9. Notas de implementación (desvíos respecto del diseño original)

- Sin revisión previa del TDD, por pedido explícito del usuario.
- `fifa.cwc` 2026 y algunas copas (FA Cup, Coupe de France, Trofeo de Campeones) no tienen todavía
  partidos de equipos conocidos en la temporada en curso: quedan vacías hasta que ESPN publique los cruces.
