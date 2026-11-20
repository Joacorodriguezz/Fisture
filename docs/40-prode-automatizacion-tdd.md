# 40 - Prode: automatizar resultados y programación (TDD)

> Technical Design Document. Estado: **propuesto, pendiente de revisión**. Tarjeta de Trello "10. Automatizar resultados y programación". Rama sugerida: `feat/prode-automatizacion`, desde `development` (después de la pila del prode, #109 → #111).
>
> Reglas del juego: `docs/37-prode-reglas.md`. Operación del piloto: `docs/38-prode-lanzamiento.md`. Diseño del prode: `docs/39-prode-tdd.md`. Este documento no repite esas piezas; solo cambia lo que hace falta para automatizar.

**Decisión del usuario que enmarca todo el diseño:** el resultado se carga solo desde el inicio, para lo que queda de **este** Clausura (unos 15 partidos de playoffs), sin período de medición previo y sin carga manual diaria. La corrección manual queda solo como excepción.

Convención: lo que dice **"a verificar en el paso 1"** es una hipótesis sobre ESPN que no se puede comprobar leyendo el código del repo. El paso 1 (§7) es un script de solo lectura que junta esa evidencia antes de escribir la lógica que depende de ella. No es un período de medición: se hace en el día, con partidos que ya se jugaron.

## 1. Contexto y problema

En el piloto, el prode es manual en sus dos partes críticas:

- **Resultado.** Un partido adoptado de ESPN puntúa solo con `prode_matches.home_goals_90/away_goals_90`, que carga el administrador con `PATCH /api/admin/prode/partidos` (`fijarResultado90`, `src/lib/prode/partidos.ts`), y solo si `matches.status = 'finished'` (`puntosPorUsuario`, `src/lib/prode/puntos.ts`). El marcador de ESPN no se usa porque puede incluir alargue, penales o un resultado administrativo (`docs/39` D3).
- **Estado y horario.** Los gobierna el sync de ESPN (`src/lib/data-providers/sync.ts`), que corre una vez por día a las 06:00 de Argentina (`sync-cron.yml`, `cron: "0 9 * * *"`). Un adoptado con el resultado ya cargado no puntúa hasta que el sync del día siguiente trae `finished` (`docs/38` §3.5, punto 4).

Lo que el código hace hoy con los datos de ESPN (verificado leyendo `src/lib/data-providers/espn.ts`):

- Pide `scoreboard?dates={año}&limit=1000` por cada año de `aniosATraer()` (en noviembre, el actual y el siguiente). Solo lee de cada evento `id`, `date`, `season`, `status.type.name`, `status.type.state`, `competitions[0].venue.fullName`, `competitions[0].competitors[].homeAway/score/team` y `competitions[0].leg.value`.
- `mapStatus` colapsa estados: cualquier nombre con `POSTPONED`, `SUSPENDED` o `DELAYED` pasa a `postponed`; con `CANCEL` o `ABANDON`, a `cancelled`; si no, `state = "in"` es `live` y `state = "post"` es `finished`. El nombre original se pierde.
- Los goles salen de `competitor.score` solo si el estado es `live` o `finished`; en otro estado quedan en `null`. Un partido que pasa de `live` a `postponed` pierde sus goles en `matches` (`docs/37`, notas).
- `ProviderMatch` (`types.ts`) no tiene parciales, período, penales ni el nombre crudo del estado.
- Los nombres de estado de `tests/unit/espn.test.ts` (`STATUS_FINAL`, `STATUS_IN_PROGRESS`, `STATUS_POSTPONED`, `STATUS_CANCELED`) los escribimos nosotros en el test: no son evidencia del formato real.
- `syncPartidos` ya lee, en una sola consulta por liga, todos los partidos de la liga (`source` del proveedor y `manual`), y ejecuta los cambios en `db.batch` de hasta 50 sentencias (`ejecutarEnLotes`).

Problemas a resolver:

1. Cargar el resultado a 90' sin intervención y sin inventar nunca un resultado.
2. Conservar la corrección manual por excepción y el recálculo de puntos.
3. Suspensiones y reprogramaciones: hoy `closed_at` se fija también por hora pasada y no distingue "postergado antes de empezar" de "suspendido a mitad de partido" (`docs/37`, notas).
4. La latencia del sync diario: un resultado llega recién a la mañana siguiente.

## 2. Objetivos y no objetivos

**Objetivos**

- Resultado a 90' automático desde el primer partido que se juegue después del deploy, con salvaguardas que prefieren dejar un partido **en espera** (sin puntos para nadie) antes que puntuar con un dato dudoso.
- Alerta cuando un partido queda en espera, para que el administrador lo resuelva por excepción.
- Carga manual que gana siempre sobre lo automático; exclusión explícita para resultados administrativos; recálculo automático al leer (como hoy).
- Interruptor de apagado de emergencia.
- Alcance mínimo para llegar a los playoffs en curso; el resto, priorizado para después (§7).

**No objetivos**

- Período de medición o modo sombra antes de activar (decisión del usuario; el riesgo está en §9).
- Una segunda fuente automática de resultados.
- Automatizar el alta de cruces o la adopción (sigue siendo `POST {adoptar, fase}`), o los cruces manuales: si ESPN trae el mismo partido, el reemplazo de `docs/39` D5 lo convierte en adoptado.
- Notificaciones a participantes, puntos persistidos o cambios a las reglas de `docs/37`.
- Actualizar el calendario de los usuarios en la ventana del partido (la reconciliación sigue siendo diaria, `docs/17`).
- Reabrir pronósticos de forma automática. Nunca.

## 3. Salvaguardas en lugar de medición previa

Sin período de medición, la confianza sale de reglas que fallan hacia el lado seguro y de detectar rápido lo que se escape:

1. **Lista blanca de estados** (D1): solo un nombre de estado de ESPN conocido como fin reglamentario produce un resultado. Un nombre desconocido deja el partido en espera.
2. **Alargue y penales solo con parciales que cierran** (D1, regla B). Si no cierran, el partido queda en espera.
3. **Confirmación** (D2): un resultado automático puntúa solo cuando se vio igual en dos lecturas separadas por 10 minutos o más, o cuando la primera lectura llega 4 horas o más después del inicio. Evita puntuar con un marcador provisorio en el instante del final, cuando ESPN puede todavía corregirlo (**a verificar en el paso 1** si ocurre; la salvaguarda no depende de eso).
4. **Rango y forma**: goles enteros de 0 a 20, los dos presentes.
5. **Manual gana siempre y exclusión explícita** (D2).
6. **Alerta de espera** (D5) y **registro de evidencia** (`auto_regla`, log con el nombre de estado) para revisar después cualquier resultado.
7. **Seguimiento posterior sin carga manual** (D5): `metricas.prode.automatizacion.corregidos` cuenta las correcciones manuales que difieren de lo automático. **Criterio de apagado**: una corrección en la regla A, o dos en la regla B, apaga esa regla por KV (D3) hasta analizar la causa con un test rojo.

## 4. Decisiones

### D1. Resultado a 90' desde ESPN: lista blanca y regla conservadora

El adaptador suma a `ProviderMatch` dos campos opcionales: `estadoProveedor` (el `status.type.name` crudo) y `goles90` (`{local, visitante, regla: "A" | "B"} | null`). `mapStatus` no cambia: `status` sigue igual para el resto de la app. `goles90` lo calcula una función pura, `resultado90DeEspn(evento)`:

- **Regla A (fin en los 90').** Si `estadoProveedor` está en `ESTADOS_FIN_REGLAMENTARIO` y `state = "post"`, `goles90` es el marcador de `competitor.score`. La lista sale del paso 1, con los nombres observados en partidos terminados en 90' (por ejemplo `STATUS_FULL_TIME` o `STATUS_FINAL`: **a verificar en el paso 1**, ninguno está comprobado en el código).
- **Regla B (alargue o penales).** Si el nombre indica alargue o penales (por ejemplo `STATUS_FINAL_AET` o `STATUS_FINAL_PEN`: **a verificar**), `goles90` es la suma de los goles de los períodos 1 y 2, **solo** si ESPN publica los parciales por período y cierran: los períodos 1 a 4 suman exactamente el marcador final de cada equipo, y la tanda de penales no está incluida en ese marcador. Campos candidatos: `competitors[].linescores[].value`, `status.period`, `competitors[].shootoutScore` (**a verificar en el paso 1**). Si falta un dato o los números no cierran, `goles90 = null`.
- **Todo lo demás da `null`**: nombres fuera de la lista (incluido un resultado administrativo o un abandono), marcadores no numéricos o fuera de rango, un evento sin `state = "post"`.

**Si el paso 1 muestra que algo no se puede asegurar**: si ESPN no distingue el fin reglamentario, no se implementa la regla A y todos los partidos quedan en espera hasta que el administrador cargue el resultado (el flujo de hoy, ahora con alerta). Si los parciales no existen o no cierran en las muestras, no se implementa la regla B y los partidos con alargue quedan en espera. Nunca se completa un dato faltante con una suposición.

- **Por qué una lista blanca**: un nombre nuevo o raro cae en espera en lugar de puntuar mal. Un error de puntaje lo ven todos los participantes; una espera, solo el administrador.
- **Descartado**: usar `competitor.score` siempre que `state = "post"` (ya descartado en `docs/39` D3); el endpoint de detalle por evento (una subrequest más por partido y un formato que el repo nunca leyó); reconstruir los 90' con los minutos de cada gol (depende de que ESPN publique todos los goles con minuto y del adicionado; más frágil que los parciales).

### D2. Columnas propias para lo automático; manual y exclusión ganan (migración 0022)

Columnas nuevas en `prode_matches`, todas nullable:

| Columna | Contenido | La escribe |
|---|---|---|
| `auto_home_goals_90`, `auto_away_goals_90` | `goles90` de ESPN | Solo el sync |
| `auto_regla` | `A` o `B`: con qué regla salió (evidencia) | Solo el sync |
| `auto_visto_at` | Primera lectura del valor actual (ms). Si el valor cambia, se reinicia | Solo el sync |
| `auto_confirmado_at` | Momento en que se cumplió la confirmación de §3.3 (ms). Si el valor cambia, vuelve a `null` | Solo el sync |
| `excluded_at` | El administrador excluyó el partido: no puntúa (ms) | Solo el PATCH admin |

Si una lectura posterior trae `goles90 = null` (ESPN cambió el estado), las columnas automáticas se vacían: el partido vuelve a espera en lugar de conservar un dato que la fuente ya no respalda.

El resultado que puntúa lo resuelve una sola expresión SQL en `puntos.ts`. Reemplaza a `goles90Local/goles90Visitante` y la usan también las métricas:

1. `excluded_at IS NOT NULL` → sin resultado.
2. Cruce manual → `matches.home_score/away_score` (como hoy).
3. Carga manual completa (`home_goals_90` y `away_goals_90`) → la manual.
4. Automático habilitado (D3), par automático completo y `auto_confirmado_at IS NOT NULL` → el automático.
5. Si no → sin resultado (en espera).

Sigue valiendo `matches.status = 'finished'`. La elección es por par: nunca se mezcla un gol manual con uno automático.

- **Por qué columnas separadas**: el sync nunca escribe `home_goals_90/away_goals_90`, así que no puede pisar una corrección, sin importar el orden en que corran el sync y el PATCH. Y como los puntos se calculan al leer (`docs/39` D1), corregir o excluir reordena el ranking sin reprocesar.
- **`PATCH {id, excluir: true}`** (y `excluir: false` para deshacerlo), sin otros campos (400 `cambios_mezclados`): para un resultado administrativo (`docs/37` §5) o un dato de ESPN que se sabe malo. Fija `closed_at` como el PATCH de resultado.
- **Cambio de semántica**: hoy `PATCH {homeGoals90: null, awayGoals90: null}` deja el partido sin puntuar. Ahora retira la corrección y vuelve a valer el automático. Para que no puntúe se usa `excluir`. Se refleja en `docs/38` (§8).
- **Descartado**: que el sync escriba en `home_goals_90/away_goals_90` con una marca de origen (tendría que leer la marca para no pisar una corrección, con la carrera de `docs/39` D6 de nuevo); una tabla de historial de resultados (con 15 partidos alcanzan `auto_regla` y los logs).

### D3. Interruptores: KV para emergencias, variable para apagar del todo

- **KV `prode:resultado_auto`** con los valores `on`, `off`, `solo-a` o `solo-b`; sin clave equivale a `on`. **Lo lee solo el sync**, una vez por invocación con partidos del prode. Con `off`, el sync no escribe ni confirma resultados automáticos; con `solo-a` o `solo-b`, solo los de esa regla. Sirve para cortar sin deploy y para el criterio de apagado de §3.7. Es el mismo patrón que `ratelimit:modo=off` (CLAUDE.md: KV solo se lee, para el interruptor).
- **Variable `PRODE_RESULTADO_AUTO`** (`on` por defecto; `off` tras un deploy). Con `off`, la lectura ignora todo lo automático (paso 4 de D2), incluido lo ya confirmado. Se lee en el handler y se pasa como booleano a `puntosPorUsuario`, `rankingProde` y `getMetricasProde`.
- **Por qué dos niveles**: el KV corta en segundos lo que viene, sin agregar una lectura de KV a cada ranking. Para lo que ya se confirmó y está mal, la corrección inmediata es por partido (carga manual o `excluir`), que gana siempre. La variable es el apagado total, con deploy, igual que `HTML_CACHE`.

### D4. El sync diario carga los resultados (P0) y un sync de ventana los acelera (P1)

**P0, sync diario, sin subrequests de más.** La consulta que `syncPartidos` ya hace por liga suma un `leftJoin` con `prode_matches` (`match_id`, columnas automáticas). Para cada partido del prode que trae ESPN, el sync agrega al mismo `ejecutarEnLotes` un `UPDATE prode_matches` cuando cambian `goles90` o la confirmación. Como son pocos partidos (unos 15), entran en el batch que ya existe. A las 06:00 todo partido de la noche anterior tiene más de 4 horas, así que se confirma con una sola lectura. Con esto, el resultado llega solo, como tarde a la mañana siguiente, y el administrador puede adelantarlo disparando a mano el workflow **Sync diario** (no es cargar datos).

**P1, sync de ventana: `POST /api/admin/prode/sync`** (Bearer `ADMIN_SECRET`, `withApi` con política de límite de tasa) y workflow `prode-sync.yml` cada 15 minutos en la franja de partidos del torneo. El repo es público, así que los minutos de Actions no tienen costo.

1. **Ventana** (1 lectura): adoptados del prode con `date_time` entre `ahora - 4 h` y `ahora + 1 h`, en `live`, o terminados sin confirmar con menos de 24 h. Si no hay ninguno, responde `{trabajo: false}` sin llamar a ESPN y sin registrar un run.
2. **ESPN**: scoreboard de cada competencia de la ventana, solo del año de cada partido, con el `pedirJson` existente (3 intentos). Tope: 3 competencias por invocación.
3. **Escritura** en un solo `db.batch`, solo para los partidos de la ventana y sin el paso de equipos: cierre (`cerrarEmpezadosDelProde`, sin cambios), `UPDATE` de `matches` con la misma comparación que el sync diario, y las columnas automáticas.
4. **Run** con `kind = 'prode'` (D6).

- **Por qué no `POST /api/admin/sync {leagueId}`**: `syncEquipos` lee todos los equipos de la fuente y `runSync` corre los chequeos de consistencia sobre `matches` entera (`docs/30`) en cada invocación con `leagueId`. Cada 15 minutos agotaría la cuota de lecturas compartida con staging (memoria del proyecto).
- **Por qué Actions**: Cloudflare Pages no ejecuta Cron Triggers (comentario de `sync-cron.yml`). GitHub no garantiza la puntualidad de un `schedule`: el objetivo de latencia es una hora, no 15 minutos.
- **Solo producción**: staging lo corre solo con `workflow_dispatch` (comparte la cuota de D1).
- **Descartado**: endpoint de detalle por evento; intervalo de 5 minutos; un Worker aparte con Cron Trigger.

**Presupuesto del sync de ventana** (tope de Workers Free: 50; se usa el margen de 45 de `calendar/presupuesto.ts`):

| Concepto | Normal | Peor caso |
|---|---|---|
| Consulta de la ventana | 1 | 1 |
| KV del interruptor | 1 | 1 |
| ESPN: 1 año por competencia, hasta 3 competencias, 3 intentos | 1 | 9 |
| Leer los partidos de la ventana por `external_id` | 1 | 3 |
| `db.batch` de cambios | 1 | 3 |
| Registro del run | 3 | 3 |
| **Total** | **8** | **20** |

En el sync diario, P0 suma 1 lectura de KV por lote con partidos del prode y ninguna consulta nueva (el `leftJoin` va en la consulta existente, y las sentencias, en el batch existente).

**Lecturas de D1.** El `leftJoin` del sync diario lee las mismas filas de `matches`. Fuera de la ventana, el sync de ventana hace una consulta sobre `prode_matches` (decenas de filas) unida a `matches` por clave primaria. Se revisan las cifras reales de D1 la primera semana (§9).

### D5. Espera, alerta y seguimiento

- **En espera**: adoptado en `finished`, sin carga manual, sin resultado automático confirmado y sin exclusión, con `date_time` de hace más de 4 horas.
- **Alerta**: después del sync, `sync-cron.yml` (y `prode-sync.yml` en P1) consulta `/api/admin/status`. Si `metricas.prode.automatizacion.enEspera > 0`, abre un issue `incidente` "Prode: resultados en espera" con `incidente.sh`, y lo cierra cuando vuelve a 0. Log `prode_resultado_en_espera` con `{matchId, estadoProveedor, motivo}` (`estado_desconocido`, `parciales_incompletos`, `parciales_no_cierran`, `sin_confirmar`).
- **Qué hace el administrador**: verifica con una fuente oficial y carga el resultado (`PATCH {id, homeGoals90, awayGoals90}`) o excluye el partido. Es el único caso en que carga datos.
- **Métricas** (`metricas.prode.automatizacion`, agregados sin ids sobre adoptados `finished`): `automaticos` (por regla), `manuales`, `corregidos` (manual distinto del automático), `enEspera`, `excluidos`. El GET admin de partidos suma a cada partido `automatico: {local, visitante, regla, confirmadoEn} | null`, `excluido` y `enEspera`.

### D6. Observabilidad del sync de ventana (P1)

- `sync_runs.kind = 'prode'`: la columna es texto (`0011`), solo cambia el tipo `SyncKind`. `checks.sync` de `/api/health` sigue mirando solo `leagues`: si el sync de ventana se registrara como `leagues`, sus éxitos taparían un sync diario caído. `/api/admin/status` agrega `runsProde`.
- `prode-sync.yml` abre un issue `incidente` "Falla el sync del prode" si una invocación con trabajo falla, y lo cierra al recuperarse.
- Log `prode_sync` con `{partidos, competencias, cambios, confirmados}`. Sin datos personales.

### D7. `started_at` y reapertura manual de postergados (P2, propuesta aceptada pendiente de confirmación)

**Qué es.** Hoy, si un partido se posterga **antes de empezar** pero ESPN lo informa después de la hora original, el prode lo ve cerrado (`closed_at` se fija por hora pasada) y no lo puede reabrir: no sabe si se postergó o si se suspendió a mitad de juego. La salida actual es cargar un cruce nuevo, que pierde los pronósticos, y eso contradice `docs/37` §5 ("tu pronóstico se mantiene"). La propuesta, que el coordinador recomendó y el usuario todavía tiene que confirmar, agrega la evidencia de inicio y una reapertura que solo hace el administrador.

- `prode_matches.started_at` (ms, nullable; en la migración 0022, aunque su lógica sea P2). Se fija una sola vez (`COALESCE`) cuando el sync ve el partido en `live` o `finished`; cuando el nombre crudo de ESPN indica suspensión en juego (por ejemplo un `SUSPENDED` con `state = "in"`: **a verificar en el paso 1**); o cuando el administrador carga `live` o `finished` en un cruce manual. Nunca por hora. Backfill: `started_at = closed_at` donde el partido hoy está en `live` o `finished`.
- `PATCH {id, reabrir: true}` borra `closed_at` solo si, en la fila vigente y en una sentencia condicional, `started_at IS NULL`, el estado es `postponed` o `scheduled` y `date_time` es futuro. Si no, responde 409 `no_reabrible`. En un cruce manual, el PATCH de horario sobre un postergado con la hora vencida pasa a aceptarse con la misma condición. Log `prode_cruce_reabierto` (solo el id).
- **Por qué nunca automática**: si el sync no vio el partido en vivo y ESPN lo pasó directo a postergado, `started_at` queda vacío aunque se haya jugado una parte. Decide una persona con la fuente oficial; la condición en SQL evita reabrir algo que el sync acaba de ver empezar.
- **Si el usuario no la confirma**: queda la regla actual (cargar un cruce nuevo). El resto del diseño no depende de esto.
- **Descartado**: historial de estados en `matches`, o el estado crudo del proveedor en `matches` (tabla caliente, escrituras en cada sync, y solo sirve al prode).

### D8. Horarios y reprogramaciones

El horario de un adoptado lo sigue gobernando ESPN: en P0, con el sync diario; en P1, además, cada 15 minutos hasta una hora antes del inicio. El cierre sigue en `date_time` (`cierraPronostico`), sin lógica nueva. Si ESPN mueve un partido ya cerrado a una fecha futura, D4 de `docs/39` lo mantiene cerrado, como hoy.

## 5. Suspensiones y reprogramaciones: comportamiento esperado

| Caso | Qué ve el sync (hipótesis de ESPN **a verificar**) | Resultado |
|---|---|---|
| Reprogramado antes de empezar, la hora nueva llega antes de la original | `scheduled` o `postponed` con fecha nueva | Sigue abierto hasta la nueva hora (como hoy) |
| Postergado antes de empezar, la hora original pasó entre dos syncs | `postponed`, nunca `live` | Cerrado por hora. Con D7: `started_at` null y el administrador puede `reabrir` |
| Suspendido en juego | `live` → `postponed`, o un nombre de suspensión | Cerrado para siempre; sin resultado; no puntúa; no está en espera (no es `finished`) |
| Suspendido y completado otro día | `finished` en la fecha de reanudación | Resultado automático si cumple D1; puntúa |
| Cancelado o abandonado | `cancelled` | No puntúa (como hoy) |
| Resultado administrativo | nombre fuera de la lista, o un final con marcador dado por la organización | Fuera de la lista: en espera y alerta, el administrador excluye. Si ESPN lo muestra como un final normal, no se detecta solo (§9) |
| ESPN corrige el marcador después del final | `finished` con otro `score` | Se reinicia la confirmación y el nuevo valor puntúa al confirmarse. Una carga manual, si existe, sigue ganando |
| ESPN vuelve un `finished` a `live` | `live` | Deja de puntuar hasta volver a `finished` |
| Alargue o penales sin parciales que cierren | nombre de alargue o penales | En espera y alerta; nunca un resultado inventado |

## 6. Estrategia de tests (rojo, verde, refactor)

Cada paso empieza con los tests en rojo. Las muestras del paso 1 se guardan como fixtures (`tests/fixtures/espn-prode-*.json`); un caso que no se observó en datos reales se marca **sintético** en el nombre del test.

| Archivo | Cubre | Prioridad |
|---|---|---|
| `tests/unit/espn-resultado-90.test.ts` (nuevo) | `resultado90DeEspn`: regla A con cada nombre de la lista; nombre desconocido → `null`; alargue o penales sin parciales → `null`; parciales que no cierran → `null`; regla B coherente; marcador no numérico o fuera de rango → `null` | P0 |
| `tests/unit/espn.test.ts` | `estadoProveedor` conserva el nombre crudo; `mapStatus` y `status` no cambian | P0 |
| `tests/integration/api/prode-puntos.test.ts` | Precedencia: excluido > manual > automático confirmado; sin confirmar no puntúa; variable `off` ignora lo automático; nunca mezcla goles de dos fuentes; corregir o excluir reordena el ranking; `null, null` vuelve al automático | P0 |
| `tests/integration/data-sync.test.ts` | El sync diario escribe y confirma lo automático sin consultas de más; un valor nuevo reinicia la confirmación; `goles90 = null` vacía lo automático; nunca escribe `home_goals_90`; KV `off`, `solo-a`, `solo-b` | P0 |
| `tests/integration/api/prode-partidos.test.ts` | `excluir` y deshacer; `cambios_mezclados` | P0 |
| `tests/observability/metricas.test.ts` | `automatizacion`: `enEspera`, `corregidos`, conteos por regla, sin ids | P0 |
| `tests/integration/api/prode-sync.test.ts` (nuevo) | Sin ventana: no llama a ESPN ni registra un run; con ventana: estado, horario, cierre y automático; tope de competencias; ESPN caído → run `failed` y nada escrito; las filas de la tabla de §5 | P1 |
| `tests/integration/api/prode-sync-presupuesto.test.ts` (nuevo) | Subrequests con la D1 instrumentada y `fetch` simulado: ≤ 20 en el peor caso, 1 fuera de la ventana | P1 |
| `tests/observability/health.test.ts` | `kind = 'prode'` no cuenta para `checks.sync`; `runsProde` | P1 |
| `tests/integration/api/prode-partidos.test.ts` | `reabrir` solo con `started_at` null, postergado y fecha futura; carrera: el sync marca `started_at` entre la lectura y la escritura → no reabre | P2 |

Refactor previsto en P1: extraer de `syncPartidos` el armado de `datos`, la comparación de cambios y las sentencias del prode, para que el sync diario y el de ventana compartan exactamente la misma lógica.

## 7. Plan de implementación, por valor y urgencia

**P0: imprescindible para los playoffs en curso (un PR, lo antes posible).**

1. **Muestras de ESPN (solo lectura, bloqueante).** Script `scripts/espn-muestras.mjs` que baja el scoreboard de partidos ya jugados este año que terminaron en 90', con alargue o por penales (Copa Argentina, Libertadores, Sudamericana y lo jugado de los playoffs del Clausura). También confirma en qué slug de ESPN están los playoffs (dato técnico: hoy se asume `arg.1`). Guarda por evento `status.type`, `status.period`, `competitors[].score`, `linescores` y `shootoutScore`, y los contrasta con resultados conocidos. Salida: la lista blanca de la regla A, la viabilidad de la regla B y la hipótesis de suspensión de D7, anotadas en las notas de este documento.
2. **Migración 0022** (columnas de D2 y `started_at`) y la precedencia de lectura en `puntos.ts` y en las métricas, con la variable de D3.
3. **Adaptador**: `estadoProveedor` y `goles90` en `ProviderMatch` y `resultado90DeEspn` con la lista del paso 1.
4. **Sync diario**: `leftJoin`, escritura y confirmación de lo automático, interruptor KV.
5. **`PATCH {excluir}`**, métricas `automatizacion`, campos del GET admin y alerta de espera en `sync-cron.yml`.
6. **Actualizar `docs/38`** según §8.

**P1: muy recomendable, entra si hay tiempo antes de las semifinales.** Sync de ventana (D4, D6): endpoint, refactor compartido, `kind = 'prode'`, presupuesto, `prode-sync.yml` con alertas. Sin P1, los resultados llegan solos a la mañana siguiente, o antes si el administrador dispara el workflow Sync diario.

**P2: después del torneo, o antes si aparece un postergado.** Lógica de `started_at` y reapertura (D7, sujeta a la confirmación del usuario).

## 8. Cambios a `docs/38` (en el PR de P0, no antes)

`docs/38` describe la operación vigente; si se cambiara ahora, describiría un comportamiento que todavía no existe. En el PR de P0:

- **§3.4 "Cargar el resultado a 90 minutos"** pasa a llamarse "Corregir un resultado". Para un adoptado de ESPN, el resultado se carga solo (`docs/40` D1-D2). El PATCH `{id, homeGoals90, awayGoals90}` queda para corregir por excepción y gana siempre. `null, null` retira la corrección y vuelve a valer el automático. Se agrega `{id, excluir: true}` para que un partido no puntúe, y `excluir: false` para deshacerlo. El cruce manual no cambia.
- **§3.5** deja de ser una carga partido por partido. El administrador atiende el issue "Prode: resultados en espera" (verifica con una fuente oficial, y carga o excluye), revisa `metricas.prode.automatizacion.corregidos` y aplica el criterio de apagado de §3.7 con el KV de D3. Se quita la cadencia de controles a los 30 y 60 minutos.
- **§3.6, cancelados y administrativos**: si ESPN mantiene `finished` con un resultado administrativo, se usa `excluir: true` (ya no "retirar el resultado"), y se deja constancia en la bitácora.
- **§5**: suma `metricas.prode.automatizacion` y, con P1, `runsProde`.

## 9. Despliegue, rollback y riesgos

**Despliegue**

- **Migración 0022, solo aditiva** (columnas nullable en `prode_matches`; el backfill solo escribe `started_at`). Va antes del código, como las anteriores (`deploy.yml` y `staging.yml` la aplican primero). Se declara en "Despliegue y riesgos" del PR. Hay que confirmar que `0022` sigue libre al integrar con `development`.
- **Variable `PRODE_RESULTADO_AUTO`**: sin definir equivale a `on`. **Clave KV `prode:resultado_auto`**: sin clave equivale a `on`.
- **Antes del release**: correr el sync en staging con un partido del prode ya terminado y comprobar el resultado automático y el ranking.
- **Orden**: release de P0 → primer sync → revisar que los partidos ya jugados sin carga manual tomen su resultado (con P0, los adoptados que hoy esperan carga pasan a puntuar solos si cumplen D1).

**Rollback**

- **Inmediato, sin deploy**: KV `prode:resultado_auto=off` (no entran resultados nuevos) y, por cada partido mal puntuado, una corrección manual o `excluir`, que ganan siempre.
- **Total**: `PRODE_RESULTADO_AUTO=off` y un deploy. Todo adoptado sin carga manual vuelve a quedar sin puntos.
- **Del código**: revertir basta; las columnas quedan sin uso. Antes, retirar la carga manual (`null, null`) de los partidos excluidos: con el código anterior volverían a puntuar con la carga que tengan.

**Riesgos**

- **Nuevo, por automatizar sin período de medición: el primer error es público.** Sin medición previa, el primer resultado automático equivocado (un nombre de estado mal interpretado, parciales mal leídos o un resultado administrativo con apariencia de final normal) cambia el ranking que ven todos, antes de que alguien lo note. Mitigación: lista blanca, confirmación, espera ante la duda, corrección inmediata que gana siempre, criterio de apagado (§3.7) y la evidencia de `auto_regla`. Lo que queda sin cubrir: un dato malo que pasa todas las reglas se detecta solo si alguien lo reporta o si el administrador lo revisa.
- **Formato de ESPN sin contrato.** Si cambian los nombres, los partidos quedan en espera (falla segura, con alerta). Si cambia el significado de un nombre conocido, no se detecta solo.
- **Muestras del paso 1 incompletas.** Si no hay partidos recientes con alargue o penales en las muestras, la regla B no se implementa y esos partidos se resuelven por excepción.
- **Latencia en P0**: el resultado llega a la mañana siguiente si P1 no entra a tiempo.
- **Lecturas de D1**: el `leftJoin` del sync diario y, en P1, 48 invocaciones diarias. Se revisan las cifras reales la primera semana.
- **Puntualidad de Actions**: un `schedule` puede atrasarse o saltearse; queda el disparo manual.
- **Calendario**: el sync de ventana cambia `date_time` pero la reconciliación de calendarios es diaria (igual que hoy).
- **Cambio de semántica de `null, null`**: mitigado con `excluir` y la actualización de `docs/38` en el mismo PR.

## 10. Preguntas abiertas para el usuario

1. **Reapertura manual de postergados (D7)**: el coordinador la recomendó; falta tu confirmación. Si no la querés, queda la regla actual.
2. **Latencia aceptable si P1 no llega a tiempo**: ¿alcanza con que los resultados aparezcan a la mañana siguiente (o al disparar el Sync diario) en las primeras fases?

## 11. Notas de implementación

_(Vacía: se completa al implementar, con los desvíos respecto de este diseño y los resultados del paso 1.)_
