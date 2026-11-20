# 40 - Prode: automatizar resultados y programación (TDD)

> Technical Design Document. Estado: **propuesto, pendiente de revisión**. Tarjeta de Trello "10. Automatizar resultados y programación (posterior al lanzamiento)". Rama sugerida: `feat/prode-automatizacion`, desde `development` (después de la pila del prode, #109 → #111).
>
> Reglas del juego: `docs/37-prode-reglas.md`. Operación del piloto: `docs/38-prode-lanzamiento.md`. Diseño del prode: `docs/39-prode-tdd.md`. Este documento no repite esas piezas; solo cambia lo que hace falta para automatizar.

Convención: todo lo que dice **"a verificar en el piloto"** es una hipótesis sobre ESPN que no se puede comprobar leyendo el código del repo. El paso 1 del plan (§7) junta esa evidencia antes de escribir lógica que dependa de ella.

## 1. Contexto y problema

En el piloto, el prode es manual en sus dos partes críticas:

- **Resultado.** Un partido adoptado de ESPN puntúa solo con `prode_matches.home_goals_90/away_goals_90`, que carga el admin con `PATCH /api/admin/prode/partidos` (`fijarResultado90`, `src/lib/prode/partidos.ts`), y solo si `matches.status = 'finished'` (`puntosPorUsuario`, `src/lib/prode/puntos.ts`). El marcador de ESPN no se usa porque puede incluir alargue, penales o un resultado administrativo (`docs/39` D3).
- **Estado y horario.** Los gobierna el sync de ESPN (`src/lib/data-providers/sync.ts`), que corre una vez por día a las 06:00 de Argentina (`sync-cron.yml`, `cron: "0 9 * * *"`). Un adoptado con el resultado ya cargado no puntúa hasta que el sync del día siguiente trae `finished` (`docs/38` §3.5, punto 4). El disparo manual del workflow es el parche.

Lo que el código hace hoy con los datos de ESPN (verificado leyendo `src/lib/data-providers/espn.ts`):

- Pide `scoreboard?dates={año}&limit=1000` por cada año de `aniosATraer()` (en noviembre, el actual y el siguiente). Solo lee de cada evento `id`, `date`, `season`, `status.type.name`, `status.type.state`, `competitions[0].venue.fullName`, `competitions[0].competitors[].homeAway/score/team` y `competitions[0].leg.value`.
- `mapStatus` colapsa estados: cualquier nombre con `POSTPONED`, `SUSPENDED` o `DELAYED` pasa a `postponed`; con `CANCEL` o `ABANDON`, a `cancelled`; si no, `state = "in"` es `live` y `state = "post"` es `finished`. El nombre original se pierde.
- Los goles salen de `competitor.score` solo si el estado es `live` o `finished`; en cualquier otro estado quedan en `null`. Por eso un partido que pasa de `live` a `postponed` pierde sus goles en `matches` (`docs/37`, notas).
- `ProviderMatch` (`types.ts`) no tiene parciales, período, penales ni el nombre crudo del estado.
- Los nombres de estado que aparecen en `tests/unit/espn.test.ts` (`STATUS_FINAL`, `STATUS_IN_PROGRESS`, `STATUS_POSTPONED`, `STATUS_CANCELED`) los escribimos nosotros en el test: no son evidencia del formato real.

Problemas a resolver:

1. No sabemos con datos cuánto se puede confiar en ESPN para horarios, estados y resultados de playoffs.
2. Automatizar el resultado sin perder la corrección manual ni el recálculo.
3. Suspensiones y reprogramaciones: hoy `closed_at` se fija también por hora pasada, así que no distingue "postergado antes de empezar" de "suspendido a mitad de partido" (`docs/37`, notas: reprogramar un postergado con la hora pasada sigue rechazado).
4. La latencia de un sync diario no sirve para que el prode puntúe poco después del final.

## 2. Objetivos y no objetivos

**Objetivos**

- Medir la confiabilidad de ESPN con una métrica concreta y un umbral de decisión, en **modo sombra** (propone pero no puntúa) antes de activar nada.
- Proponer automáticamente el resultado a 90' **solo** cuando el evento de ESPN prueba que terminó en el tiempo reglamentario, y dejar el resto en manual.
- Que la carga manual gane siempre sobre lo automático, que exista una exclusión explícita (resultado administrativo) y que el recálculo siga siendo automático al leer.
- Traer estado y horario de los partidos del prode cerca del momento del partido, no al día siguiente, dentro del presupuesto de Workers Free y sin gastar lecturas de D1 fuera de la ventana de partido.
- Registrar la evidencia de inicio (`started_at`) para distinguir postergado de suspendido, y permitir reabrir un postergado que nunca empezó solo por acción explícita del admin.
- Cubrir con tests suspensiones, reprogramaciones, cancelaciones y correcciones de ESPN.

**No objetivos**

- Cambiar de proveedor o sumar una segunda fuente automática (una fuente secundaria sigue siendo la persona de guardia).
- Automatizar el alta de cruces o la adopción de partidos (sigue siendo `POST {adoptar, fase}`).
- Automatizar los cruces manuales: si ESPN trae el mismo partido, el reemplazo de `docs/39` D5 ya lo convierte en adoptado.
- Notificaciones a participantes, recálculo persistido de puntos o cambios en las reglas de `docs/37`.
- Actualizar el calendario de los usuarios en la ventana de partido: la reconciliación de calendarios sigue siendo diaria (`docs/17`).
- Reabrir pronósticos de forma automática. Nunca.

## 3. Medir antes de automatizar

### 3.1 Qué se mide

Cada partido adoptado del piloto deja, sin intervención extra, dos resultados para comparar: el manual (`home_goals_90/away_goals_90`, de la guardia de `docs/38` §3.5) y la **propuesta automática** (columnas nuevas, §4 D2). Para horario y estado, la comparación sale de la bitácora de la guardia, que ya registra la hora publicada una hora antes y el final confirmado.

| Métrica | Definición | Fuente | Umbral para automatizar |
|---|---|---|---|
| **M1. Concordancia del resultado** | Partidos con propuesta y con carga manual cuya propuesta coincide exactamente / partidos con propuesta y carga manual | `metricas.prode.automatizacion` (§4 D8) | **100 %** (cero discrepancias) con **al menos 10 partidos** comparados |
| **M2. Cobertura de la propuesta** | Adoptados terminados en el tiempo reglamentario (según la bitácora) con propuesta / adoptados terminados en el tiempo reglamentario | `metricas.prode.automatizacion` + bitácora | **≥ 90 %** |
| **M3. Latencia del estado final** | Minutos entre el final real (bitácora) y `auto_at` (primera vez que el sync vio el partido terminado con propuesta) | GET admin (`propuesta.en`) + bitácora | **≤ 60 min** en todos los partidos (el mismo plazo de escalamiento de `docs/38` §3.5) |
| **M4. Horario** | Partidos cuyo horario en Fisture una hora antes del inicio difiere del oficial | bitácora (punto 1 de la guardia) | **0** |
| **M5. Estados especiales** | Suspensiones, postergaciones y cancelaciones reales en las que el estado de ESPN no coincidió con lo ocurrido | bitácora | **0** |

**Por qué estos umbrales.** Un resultado mal cargado cambia el ranking de todos. Con una muestra chica (los playoffs del Clausura son 15 partidos si son 16 equipos; **a verificar**), un solo error ya es una tasa inaceptable, y no hay muestra que justifique tolerar errores. Por eso M1 exige cero discrepancias y un mínimo de casos. M2 es menos exigente porque un faltante no daña: cae a la carga manual, que ya existe.

**Partidos con alargue o penales.** La propuesta para estos casos (§4 D1, regla B) se mide aparte. Se activa recién con **al menos 3 casos concordantes**, que en un solo torneo pueden no darse; si no se dan, quedan en manual y se vuelve a medir en el próximo torneo.

### 3.2 Decisión

- **Cumple M1, M2 y M3:** se activa `PRODE_RESULTADO_AUTO=on` (§4 D3) para la regla A (fin en el tiempo reglamentario). La guardia deja de cargar los resultados de esos partidos y pasa a revisarlos dentro de la hora: corrige solo si hace falta.
- **Falla M1:** no se activa. Se analiza cada discrepancia; si la causa es una regla de detección, se corrige con un test rojo y se vuelve a medir desde cero.
- **Falla M2 o M3 sin fallar M1:** se puede activar, pero la guardia sigue igual para los partidos sin propuesta o con propuesta tardía.
- **Falla M4 o M5:** no cambia la decisión sobre los resultados, pero la guardia mantiene el control de horario una hora antes y se agrega la incidencia a la sección de riesgos.

La decisión y sus cifras se registran en las notas de implementación de este documento y en la bitácora, igual que la evaluación del piloto (`docs/38` §6).

## 4. Decisiones

### D1. Resultado a 90' desde ESPN: lista blanca de estados y regla conservadora

El adaptador suma a `ProviderMatch` dos campos opcionales: `estadoProveedor` (el `status.type.name` crudo) y `goles90` (`{local, visitante} | null`). `mapStatus` no cambia: `status` sigue igual para el resto de la app. `goles90` lo calcula una función pura, `resultado90DeEspn(evento)`, con dos reglas:

- **Regla A (fin reglamentario).** Si `estadoProveedor` está en `ESTADOS_FIN_REGLAMENTARIO` y `state = "post"`, `goles90` es el marcador de `competitor.score`. La lista blanca empieza **vacía** y se llena en el paso 1 con los nombres observados en partidos terminados en 90' (por ejemplo `STATUS_FULL_TIME` o `STATUS_FINAL`: **a verificar en el piloto**, ninguno está comprobado en el código).
- **Regla B (alargue o penales).** Si el nombre indica alargue o penales (por ejemplo `STATUS_FINAL_AET` o `STATUS_FINAL_PEN`: **a verificar**), `goles90` sale de los parciales **solo** si ESPN los publica por período y suman exactamente el marcador del alargue: goles de los períodos 1 y 2. Los campos candidatos (`competitors[].linescores[].value`, `status.period`, `competitors[].shootoutScore`, o los goles con minuto en `competitions[].details[]`) son **a verificar en el piloto**. Si falta un dato o los números no cierran, `goles90 = null`. Esta regla no se activa hasta cumplir lo dicho en §3.1.
- **Todo lo demás da `null`**: estados fuera de la lista (un nombre nuevo, un resultado administrativo, un abandono), marcadores no numéricos o un evento sin `state = "post"`.

**Qué hacer si no se puede.** Si el paso 1 muestra que ESPN no distingue el fin reglamentario (por ejemplo, el mismo nombre para 90' y para alargue), la regla A no se implementa y el resultado sigue manual. Igual se implementan el sync de ventana (D4), `started_at` (D5) y la exclusión (D2): resuelven la latencia y las suspensiones sin depender de esta respuesta.

- **Por qué una lista blanca y no una lista negra**: un nombre de estado nuevo o raro (un resultado administrativo con un nombre que no conocemos) cae en `null` y va a la guardia, en lugar de puntuar mal. El costo de equivocarse en una lista negra lo pagan todos los participantes.
- **Descartado**: usar `competitor.score` siempre que `state = "post"` (es lo que `docs/39` D3 ya descartó); pedir el endpoint de detalle de cada evento (más subrequests por partido y un formato que el repo nunca leyó, **a verificar** si fuera necesario para la regla B); calcular los 90' con los minutos de los goles como primera opción (depende de que ESPN publique todos los goles con minuto y del adicionado, que es más frágil que los parciales).

### D2. Propuesta separada, manual siempre gana, exclusión explícita (migración 0022)

Columnas nuevas en `prode_matches`, todas nullable:

| Columna | Contenido | La escribe |
|---|---|---|
| `auto_home_goals_90`, `auto_away_goals_90` | Propuesta de ESPN (`goles90`) | Solo el sync |
| `auto_at` | Primera vez que el sync escribió una propuesta (ms) | Solo el sync (`COALESCE(auto_at, ahora)`) |
| `excluded_at` | El admin excluyó el partido del prode: no puntúa (ms) | Solo el PATCH admin |
| `started_at` | Evidencia de inicio (ms), ver D5 | Sync y PATCH admin |

El resultado que puntúa lo resuelve una sola expresión SQL en `puntos.ts`, que reemplaza a `goles90Local/goles90Visitante` y que usan también las métricas:

1. `excluded_at IS NOT NULL` → sin resultado.
2. Cruce manual → `matches.home_score/away_score` (como hoy).
3. Carga manual completa (`home_goals_90` y `away_goals_90`) → la manual.
4. `PRODE_RESULTADO_AUTO = on` y propuesta completa → la propuesta.
5. Si no → sin resultado.

Sigue valiendo la condición de `matches.status = 'finished'`. La elección es por par (los dos goles de la misma fuente), nunca un `COALESCE` gol por gol, que podría mezclar un local manual con un visitante automático.

- **Por qué columnas separadas**: el sync nunca escribe `home_goals_90/away_goals_90`, así que no puede pisar una corrección. Que gane lo manual no depende del orden en que corren el sync y el PATCH: es una regla de lectura. Y como los puntos se calculan al leer (`docs/39` D1), corregir o excluir reordena el ranking sin reprocesar.
- **Cambio de semántica que hay que documentar**: hoy `PATCH {homeGoals90: null, awayGoals90: null}` "retira la confirmación" y el partido deja de puntuar. Con la propuesta activa, retirar la carga manual hace que vuelva a valer la automática. Para que un partido no puntúe (resultado administrativo, `docs/37` §5; `docs/38` §3.6) se usa `PATCH {id, excluir: true}` (y `excluir: false` para deshacerlo), sin otros campos (400 `cambios_mezclados`, como hoy). Se actualizan `docs/38` §3.4 y §3.6 en el mismo PR.
- **Descartado**: que el sync escriba directamente en `home_goals_90/away_goals_90` con una marca de origen (`result_source`). Un sync que corre después de una corrección tendría que leer la marca y decidir no pisar, con la carrera de `docs/39` D6 de nuevo; dos columnas no tienen carrera. También se descartó una tabla de historial de resultados: con 15 partidos, la bitácora ya cumple esa función.

### D3. Interruptor `PRODE_RESULTADO_AUTO` (variable de entorno, `off` por defecto)

Con `off` (modo sombra), el sync escribe las propuestas pero la lectura las ignora: las métricas de §3 se pueden medir sin que nada puntúe solo. Con `on`, se aplica el paso 4 de D2. Se lee en el handler (`locals.runtime.env`) y se pasa a `puntosPorUsuario`, `rankingProde` y `getMetricasProde` como un booleano. No se lee KV en cada ranking.

- **Por qué una variable y no KV**: el ranking se lee mucho; una lectura de KV por request es una subrequest más en cada lectura y un costo de cuota. Cambiar el modo sin un deploy no hace falta: la corrección de emergencia es por partido (carga manual o `excluir`), y gana siempre. Mismo criterio que `HTML_CACHE` (CLAUDE.md, Observabilidad).
- **Descartado**: activar por partido (una columna `auto_ok`). Obliga a la guardia a tocar cada partido, que es justo lo que se quiere dejar de hacer.

### D4. Sync de ventana del prode: `POST /api/admin/prode/sync`

Endpoint nuevo (Bearer `ADMIN_SECRET`, `withApi` con política de límite de tasa propia) y workflow `prode-sync.yml` que lo llama **cada 15 minutos** en la franja con partidos del torneo (por ejemplo, de 15:00 a 03:00 de Argentina; los horarios se ajustan al calendario del torneo). El endpoint:

1. **Consulta la ventana** (1 lectura): partidos adoptados del prode con `date_time` entre `ahora - 4 h` y `ahora + 1 h`, o con estado `live`, o terminados sin propuesta y con menos de 24 h. Si no hay ninguno, responde `{trabajo: false}` sin pedir nada a ESPN y **sin registrar un run** (así no se suman 48 filas por día a `sync_runs`).
2. **Pide a ESPN** el scoreboard de cada competencia de esos partidos, **solo** para el año de cada partido (no los dos de `aniosATraer`), con el `pedirJson` existente (3 intentos). Tope: 3 competencias por invocación.
3. **Actualiza solo los partidos de la ventana**, por `external_id`, sin el paso de equipos ni el de participación: un adoptado ya tiene sus equipos. En un solo `db.batch`: el cierre de `cerrarEmpezadosDelProde` (sin cambios de criterio), la marca de `started_at` (D5), los `UPDATE` de `matches` que cambiaron (los mismos campos que el sync diario) y los de la propuesta en `prode_matches`.
4. **Registra el run** con `kind = 'prode'` (D7).

El sync diario también escribe `started_at` y la propuesta de los partidos del prode que vea, en el mismo batch que ya ejecuta (sentencias extra, sin subrequests extra), así un día sin workflow de ventana no deja huecos.

- **Por qué un endpoint propio y no `POST /api/admin/sync {leagueId}`**: ese camino ya existe, pero `syncLeague` lee todos los equipos de la fuente (`syncEquipos`: `select ... from teams where source = 'espn'`) y `runSync` corre los chequeos de consistencia, que recorren `matches` entera (`docs/30`), en cada invocación con `leagueId`. Cada 15 minutos sería el mismo tipo de consumo de lecturas que agota la cuota compartida con staging (memoria del proyecto). El endpoint de ventana lee unas decenas de filas.
- **Por qué un workflow de GitHub Actions**: Cloudflare Pages no ejecuta Cron Triggers (comentario de `sync-cron.yml`); es el mismo mecanismo que el sync diario y la reconciliación. GitHub no garantiza la puntualidad de un `schedule`, por eso M3 se mide con lo que ocurre de verdad y la latencia aceptada es una hora, no 15 minutos.
- **Solo producción.** Staging no corre este workflow por `schedule` (solo `workflow_dispatch`): no tiene participantes reales y comparte la cuota de D1.
- **Descartado**: el endpoint de detalle de un evento por partido (formato no verificado y una subrequest por partido); bajar el intervalo a 5 minutos (triplica invocaciones sin cambiar la decisión de M3); un Worker aparte con Cron Trigger (otro despliegue, otra configuración y otros secretos para una sola función).

### D5. `started_at`: sí hace falta (migración aditiva)

`closed_at` responde "¿se puede pronosticar?" y se fija también por hora pasada, aunque el partido no haya empezado. Falta un dato distinto: "¿hay evidencia de que la pelota rodó?". `prode_matches.started_at` (ms, nullable) se fija una sola vez (`COALESCE`) cuando:

- el sync (diario o de ventana) ve el partido en `live` o `finished`; o
- el nombre crudo de ESPN indica suspensión después de empezar (un `SUSPENDED` con `state = "in"`, por ejemplo: **a verificar en el piloto** qué nombre y qué `state` usa ESPN para un partido suspendido en juego y para uno postergado antes del inicio); o
- el admin carga `status: live` o `finished` en un cruce manual.

Nunca se fija por hora. Backfill en la migración: `started_at = closed_at` para los vínculos cuyos partidos están hoy en `live` o `finished`. Los postergados quedan en `null` (no hay evidencia; ver la reapertura abajo).

**Reapertura, solo manual y acotada.** `PATCH {id, reabrir: true}` (cruce manual o adoptado) borra `closed_at` solo si, en la fila vigente y en una sola sentencia condicional: `started_at IS NULL`, estado `postponed` o `scheduled` y `date_time` futuro. Si no, 409 `no_reabrible`. En un cruce manual, el PATCH de horario sobre un postergado con la hora vencida pasa a aceptarse con esa misma condición (hoy da 409 `partido_ya_empezado`, `docs/37` notas). Se loguea `prode_cruce_reabierto` (solo el id del partido).

- **Por qué**: la regla de `docs/37` §5 dice que un reprogramado antes de empezar sigue abierto y "tu pronóstico se mantiene". Hoy, si la hora pasó entre dos syncs, el partido queda cerrado y la salida es cargar un cruce nuevo, que pierde los pronósticos.
- **Por qué nunca automática**: un falso negativo de `started_at` (el sync no vio el partido en vivo y ESPN lo pasó directo a postergado) reabriría un partido que se jugó en parte. Por eso decide una persona con la fuente oficial, y la condición en SQL evita reabrir algo que el sync acaba de ver empezar.
- **Descartado**: guardar el historial de estados en `matches` (tabla caliente, escrituras en cada sync y un cambio que no es aditivo para el resto de la app); guardar el `estadoProveedor` en `matches` (lo mismo, y solo sirve al prode); mantener la regla actual sin reapertura (es la alternativa si el usuario no quiere tocar D4 de `docs/39`).

### D6. Horarios y reprogramaciones

El horario de un adoptado lo sigue gobernando ESPN, ahora con el sync de ventana (hasta una hora antes del inicio, cada 15 minutos). El cierre sigue en `date_time` (`cierraPronostico`); no hay lógica nueva. Lo nuevo es la **medición**: el GET admin agrega `horarioCambiadoEn` (último cambio de `date_time` que vio el sync de ventana, ms) para que la guardia lo compare con la fuente oficial (M4). Si ESPN mueve un partido a una fecha futura cuando ya está cerrado, D4 de `docs/39` lo mantiene cerrado, como hoy.

- **Descartado**: congelar el horario de ESPN dentro de la hora previa (un cambio real de último momento quedaría mal) y comparar contra una segunda fuente automática (fuera de alcance).

### D7. Observabilidad y presupuesto

- **`sync_runs.kind = 'prode'`.** La columna es texto (`0011`), solo cambia el tipo `SyncKind`. `checks.sync` de `/api/health` sigue mirando solo `leagues`: si el sync de ventana se registrara como `leagues`, sus éxitos frecuentes taparían un sync diario caído. `/api/admin/status` agrega `runsProde` (últimos 20).
- **Alertas.** `prode-sync.yml` abre un issue `incidente` ("Falla el sync del prode") si una invocación con trabajo falla, y lo cierra al recuperarse (`incidente.sh`, como `sync-cron.yml`).
- **Logs.** `prode_sync` con `{partidos, competencias, cambios, propuestas, iniciados}`; `prode_propuesta_descartada` con `{matchId, estadoProveedor}` cuando un partido terminó y la regla dio `null` (es el insumo de M2 y del paso 1). Sin datos personales.

**Presupuesto de subrequests por invocación del sync de ventana** (tope de Workers Free: 50; se usa el margen de 45 de `calendar/presupuesto.ts`):

| Concepto | Normal | Peor caso |
|---|---|---|
| Consulta de la ventana | 1 | 1 |
| ESPN: 1 año por competencia, hasta 3 competencias, 3 intentos | 1 | 9 |
| Leer los partidos de la ventana por `external_id` | 1 | 3 |
| `db.batch` de cambios (cierre, inicio, partidos, propuestas) | 1 | 3 |
| Registro del run (inicio, fin, purga de runs viejos) | 3 | 3 |
| **Total** | **7** | **19** |

Un test lo fija con la D1 instrumentada (D8). Fuera de la ventana la invocación cuesta 1 consulta.

**Lecturas de D1.** Fuera de la ventana: una consulta sobre `prode_matches` (decenas de filas) unida a `matches` por clave primaria, 48 veces por día. En la ventana: unas decenas de filas por invocación. Las cifras reales se toman de D1 en la primera semana (riesgo en §9).

### D8. Métricas de la automatización

`metricas.prode.automatizacion` en `/api/admin/status`, con agregados sin ids sobre los adoptados `finished`: `conPropuesta`, `conManual`, `comparados` (los dos), `coinciden`, `difieren`, `sinPropuesta`, `excluidos`. El GET admin de partidos suma a cada partido `propuesta: {local, visitante, en} | null`, `excluido` e `iniciadoEn`. Con eso la guardia calcula M1 a M3 sin consultar la base a mano.

## 5. Suspensiones y reprogramaciones: casos y comportamiento esperado

| Caso | Qué ve el sync (hipótesis de ESPN **a verificar**) | Resultado esperado |
|---|---|---|
| Reprogramado antes de empezar, la hora nueva llega antes de la original | `scheduled` o `postponed` con fecha nueva | Sigue abierto hasta la nueva hora (como hoy) |
| Postergado antes de empezar, la hora original pasó entre dos syncs | `postponed`, nunca `live` | Cerrado por hora; `started_at` null; el admin puede `reabrir` con la nueva fecha |
| Suspendido en juego, el sync lo vio en vivo | `live` → `postponed` sin goles | Cerrado para siempre; `started_at` fijado; sin propuesta; no puntúa |
| Suspendido en juego, el sync no lo vio en vivo | nombre de suspensión con `state = "in"` | `started_at` fijado si se confirma la hipótesis; si no, queda null y la guardia decide: no reabrir |
| Suspendido y completado otro día | `finished` en la fecha de reanudación | Propuesta con el marcador final si el nombre está en la lista blanca; puntúa como cualquier partido |
| Cancelado o abandonado | `cancelled` | No puntúa (como hoy), haya o no propuesta |
| Resultado administrativo | nombre fuera de la lista blanca, o `finished` con un marcador dado por la organización | Sin propuesta. Si ESPN lo muestra como un final normal, la guardia lo excluye (`excluir: true`) |
| ESPN corrige un marcador después del final | `finished` con otro `score` | La propuesta se actualiza; el ranking se recalcula al leer; la carga manual, si existe, sigue ganando |
| ESPN vuelve un `finished` a `live` | `live` | Deja de puntuar hasta volver a `finished`; la propuesta queda guardada |

## 6. Estrategia de tests (rojo, verde, refactor)

Cada paso del plan empieza con los tests en rojo. Las muestras de ESPN del paso 1 se guardan como fixtures (`tests/fixtures/espn-prode-*.json`); un caso que no se observó en datos reales se marca **sintético** en el nombre del test.

| Archivo | Cubre |
|---|---|
| `tests/unit/espn-resultado-90.test.ts` (nuevo) | `resultado90DeEspn`: regla A con cada nombre de la lista; nombre desconocido → `null`; alargue y penales sin parciales → `null`; parciales que no cierran → `null`; regla B con parciales coherentes; marcador no numérico → `null` |
| `tests/unit/espn.test.ts` | `estadoProveedor` conserva el nombre crudo; `mapStatus` y `status` no cambian (regresión) |
| `tests/integration/api/prode-puntos.test.ts` | Precedencia: manual sobre propuesta; excluido sobre todo; propuesta ignorada con `off`; par incompleto no puntúa; nunca mezcla goles de distintas fuentes; corrección y exclusión reordenan el ranking |
| `tests/integration/api/prode-partidos.test.ts` | `excluir` (y deshacer); `cambios_mezclados`; `reabrir` solo con `started_at` null, postergado y fecha futura (409 `no_reabrible` en el resto); horario de un manual postergado con la hora vencida y sin inicio; carrera: el sync marca `started_at` entre la lectura y la escritura → no reabre |
| `tests/integration/api/prode-sync.test.ts` (nuevo) | Sin ventana: no llama a ESPN ni registra run; con ventana: actualiza estado y horario, fija `closed_at` y `started_at`, escribe la propuesta y nunca `home_goals_90`; tope de competencias; ESPN caído → run `failed` y nada escrito; cada fila de la tabla de §5 |
| `tests/integration/data-sync.test.ts` | El sync diario también fija `started_at` y la propuesta, sin consultas de más |
| `tests/integration/api/prode-sync-presupuesto.test.ts` (nuevo) | Subrequests contadas con la D1 instrumentada y `fetch` simulado: ≤ 19 en el peor caso, 1 fuera de la ventana |
| `tests/observability/health.test.ts` | `kind = 'prode'` no cuenta para `checks.sync`; `runsProde` en el status |
| `tests/observability/metricas.test.ts` | `metricas.prode.automatizacion`: conteos de `coinciden`, `difieren` y `sinPropuesta` sin ids |

Refactor previsto: extraer de `syncPartidos` el armado de `datos` y la detección de cambios, para que el sync diario y el de ventana compartan exactamente la misma comparación.

## 7. Plan de implementación

1. **Muestras de ESPN (sin código de producto).** Script de solo lectura `scripts/espn-muestras.mjs` que baja el scoreboard de competencias con partidos ya terminados por alargue o penales este año (Copa Argentina, Libertadores, Sudamericana y los playoffs de `arg.1`; **a verificar** en qué slug publica ESPN los playoffs del Clausura) y guarda por evento `status.type`, `status.period`, `competitors[].score`, `linescores`, `shootoutScore` y `details`. Se contrastan con resultados conocidos. Salida: la lista blanca de la regla A, la viabilidad de la regla B y la respuesta a la hipótesis de suspensión de D5, registradas en las notas de este documento. Si la regla A no es viable, se salta el paso 3 (D1, "qué hacer si no se puede").
2. **Migración 0022** (`auto_home_goals_90`, `auto_away_goals_90`, `auto_at`, `excluded_at`, `started_at`, con backfill de `started_at`) y precedencia de lectura en `puntos.ts` con `PRODE_RESULTADO_AUTO` (D2, D3). `excluir` en el PATCH. Actualizar `docs/38` §3.4 y §3.6.
3. **Adaptador**: `estadoProveedor` y `goles90` en `ProviderMatch`; `resultado90DeEspn` con la lista del paso 1.
4. **`started_at` y reapertura** (D5): sync diario, PATCH admin, `reabrir`.
5. **Sync de ventana** (D4): endpoint, refactor compartido con el sync diario, `kind = 'prode'`, presupuesto.
6. **Observabilidad** (D7, D8): métricas, GET admin, `runsProde`, workflow `prode-sync.yml` con alertas.
7. **Modo sombra en producción** durante el torneo siguiente (o lo que quede del actual): medir M1 a M5 con la guardia de `docs/38` sin cambios.
8. **Decisión** (§3.2) y, si corresponde, activar `PRODE_RESULTADO_AUTO=on` con un deploy y ajustar la guardia de `docs/38` §3.5 a "revisar en vez de cargar".

Los pasos 2 a 6 pueden ir en PRs separados a `development`; el 7 y el 8 son operación.

## 8. Despliegue y rollback

- **Migración 0022, solo aditiva** (columnas nullable en `prode_matches`; el backfill solo escribe `started_at`). Va antes del código, como las anteriores (`deploy.yml` y `staging.yml` ya la aplican primero). Con el código anterior, las columnas se ignoran. Se declara en "Despliegue y riesgos" del PR. Numeración: confirmar que `0022` sigue libre al integrar con `development`.
- **Variable nueva `PRODE_RESULTADO_AUTO`**: sin definir equivale a `off`. Se define en producción recién en el paso 8.
- **Secretos del workflow**: los mismos de `sync-cron.yml` (`PUBLIC_APP_URL`, `ADMIN_SECRET`).
- **Orden**: deploy con `off` → habilitar `prode-sync.yml` → modo sombra → decisión → `on`.
- **Rollback**:
  - de la automatización: `PRODE_RESULTADO_AUTO=off` y un deploy. Para un partido puntual sin esperar el deploy: carga manual o `excluir: true`, que ganan siempre;
  - del sync de ventana: desactivar `prode-sync.yml` (Actions → Disable workflow). El sync diario sigue como hoy;
  - del código: revertir basta; las columnas quedan sin uso. Si se revierte después de usar `excluir`, esos partidos vuelven a puntuar con la carga manual que tengan: antes de revertir, retirar su carga manual (`null, null`).

## 9. Riesgos

- **Formato de ESPN no documentado.** Toda la regla de 90' depende de nombres y campos sin contrato (§1). Un cambio silencioso de nombres hace caer las propuestas en `null` (falla segura: va a la guardia). Un cambio de semántica (el mismo nombre con otro significado) no se detecta solo. Mitigación: la lista blanca, `prode_propuesta_descartada` y que la guardia revise dentro de la hora aun con `on`.
- **Muestra chica.** 15 partidos pueden no alcanzar el mínimo de M1 si hay pocos adoptados o muchos manuales. En ese caso la decisión se posterga al torneo siguiente; no se baja el umbral.
- **Resultado administrativo con apariencia de final.** Si ESPN muestra un partido dado por perdido como un final normal, la regla A lo propondría. Mitigación: la guardia verifica y excluye. Se documenta como un control que no se puede automatizar.
- **Falso negativo de `started_at`.** Un partido suspendido que nadie vio en vivo queda sin evidencia. La reapertura es manual y con la fuente oficial (D5).
- **Lecturas de D1 y Actions.** 48 invocaciones diarias del workflow y unas 20 con trabajo en un día de partido. Hay que medir las lecturas en D1 la primera semana y los minutos de Actions si el repo es privado (**a confirmar**). Mitigación: reducir la franja o el intervalo.
- **Puntualidad de GitHub Actions.** Un `schedule` puede atrasarse o saltearse. M3 lo mide; el disparo manual sigue disponible.
- **Calendario.** El sync de ventana cambia `date_time` de un adoptado pero la reconciliación de calendarios corre una vez por día: el evento del usuario puede quedar con la hora vieja hasta las 06:00. Es igual que hoy con el sync diario; queda como no objetivo.
- **Cambio de semántica del retiro (`null, null`).** Con `on`, retirar la carga manual hace que vuelva a valer la propuesta. Mitigación: `excluir` y la actualización de `docs/38` en el mismo PR.

## 10. Preguntas abiertas para el usuario

1. ¿El modo sombra se mide en lo que queda de este Clausura o en el próximo torneo? Define si los pasos 2 a 6 son urgentes.
2. ¿Se acepta la reapertura manual de D5 (excepción acotada a "`closed_at` no se borra")? La alternativa es mantener la regla actual (cargar un cruce nuevo, que pierde los pronósticos).
3. ¿El repo es privado? El costo de minutos de Actions de `prode-sync.yml` depende de eso.
4. ¿Qué franja horaria y qué días cubre el workflow? Depende del calendario oficial de los playoffs.

## 11. Notas de implementación

_(Vacía: se completa al implementar, con los desvíos respecto de este diseño y los resultados del paso 1 y de la medición.)_
