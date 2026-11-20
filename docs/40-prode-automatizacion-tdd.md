# 40 - Prode: quién pasa y automatización de resultados (TDD)

> Technical Design Document. Estado: **propuesto, pendiente de revisión**. Tarjeta de Trello "10. Automatizar resultados y programación", más la regla de puntos "quién pasa", aprobada por el usuario. Rama sugerida: `feat/prode-automatizacion`, desde `development` (después de la pila del prode, #109 → #111).
>
> Reglas del juego: `docs/37-prode-reglas.md`. Operación del piloto: `docs/38-prode-lanzamiento.md`. Diseño del prode: `docs/39-prode-tdd.md`. Este documento no repite esas piezas; solo cambia lo que hace falta.

**Decisiones del usuario que enmarcan el diseño**

1. El resultado se carga solo desde el inicio, para lo que queda de **este** Clausura (unos 15 partidos de playoffs), sin período de medición previo y sin carga manual diaria. La corrección manual queda solo como excepción.
2. **Regla nueva de puntos**: el marcador a los 90' puntúa igual que hoy (3 exacto, 1 ganador o empate, 0 si no) y se suma **+1 por acertar qué equipo pasa de ronda** (en 90', alargue o penales). El +1 **no desempata** (confirmado). Los playoffs del Clausura son a partido único. El piloto todavía no empezó: el cambio de regla es reversible.
3. **Sync tras el final**: dos pasadas por partido, a las +2 h y +3 h del inicio. El sync diario queda como respaldo (D4).
4. **Sin reapertura de postergados**: en playoffs hay fecha fija y partido único. Un suspendido en juego sigue la regla de `docs/37` §5: cerrado y sin puntos hasta que se complete (D7).

Convención: lo que dice **"a verificar en el paso 5"** es una hipótesis sobre ESPN que no se puede comprobar leyendo el código del repo. El paso 5 (§8) es un script de solo lectura que junta esa evidencia con partidos históricos de ESPN. No es un período de medición: se hace en el día. Lo que confirma se reconfirma con los primeros partidos reales de los playoffs, por si ESPN cambió el formato.

## 1. Contexto y problema

En el piloto, el prode es manual en sus dos partes críticas:

- **Resultado.** Un partido adoptado de ESPN puntúa solo con `prode_matches.home_goals_90/away_goals_90`, que carga el administrador con `PATCH /api/admin/prode/partidos` (`fijarResultado90`, `src/lib/prode/partidos.ts`), y solo si `matches.status = 'finished'` (`puntosPorUsuario`, `src/lib/prode/puntos.ts`). El marcador de ESPN no se usa porque puede incluir alargue, penales o un resultado administrativo (`docs/39` D3).
- **Estado y horario.** Los gobierna el sync de ESPN (`src/lib/data-providers/sync.ts`), que corre una vez por día a las 06:00 de Argentina (`sync-cron.yml`, `cron: "0 9 * * *"`). Un adoptado con el resultado cargado no puntúa hasta que el sync del día siguiente trae `finished` (`docs/38` §3.5, punto 4).

Lo que el código hace hoy con los datos de ESPN (verificado leyendo `src/lib/data-providers/espn.ts`):

- Pide `scoreboard?dates={año}&limit=1000` por cada año de `aniosATraer()` (en noviembre, el actual y el siguiente). Solo lee de cada evento `id`, `date`, `season`, `status.type.name`, `status.type.state`, `competitions[0].venue.fullName`, `competitions[0].competitors[].homeAway/score/team` y `competitions[0].leg.value`. No lee `competitors[].winner` ni ningún dato de penales.
- `mapStatus` colapsa estados: cualquier nombre con `POSTPONED`, `SUSPENDED` o `DELAYED` pasa a `postponed`; con `CANCEL` o `ABANDON`, a `cancelled`; si no, `state = "in"` es `live` y `state = "post"` es `finished`. El nombre original se pierde.
- Los goles salen de `competitor.score` solo si el estado es `live` o `finished`; en otro estado quedan en `null`.
- `ProviderMatch` (`types.ts`) no tiene parciales, período, penales, ganador ni el nombre crudo del estado.
- Los nombres de estado de `tests/unit/espn.test.ts` (`STATUS_FINAL`, etc.) los escribimos nosotros: no son evidencia del formato real.
- `syncPartidos` ya lee, en una sola consulta por liga, los partidos de la liga (`source` del proveedor y `manual`) y ejecuta los cambios en `db.batch` de hasta 50 sentencias (`ejecutarEnLotes`).

Y lo que hace hoy el prode con los puntos (verificado en `reglas.ts`, `puntos.ts`, `ranking.ts`, `pronosticos.ts`):

- `prode_predictions` guarda solo `home_goals` y `away_goals` (migración 0019).
- `calcularPuntos` devuelve 3, 1 o 0. `puntosPorUsuario` marca `exacto: puntos === 3` y `acierto: puntos > 0`. El desempate (`compararParticipantes`) es puntos, exactos, aciertos y nombre.
- El resumen de reglas visible está en `src/pages/prode/index.astro` (`<details class="prode-reglas">`) y el formulario, en `ProdePronosticos.tsx`.

Problemas a resolver:

1. Sumar la regla "quién pasa" sin romper los pronósticos ya cargados ni el desempate.
2. Cargar el marcador a 90' y quién pasó sin intervención, y sin inventar nunca un resultado.
3. Conservar la corrección manual por excepción y el recálculo de puntos.
4. Suspensiones y reprogramaciones: que la automatización no puntúe un partido suspendido ni reabra uno cerrado.
5. La latencia del sync diario: hoy un resultado llega recién a la mañana siguiente.

## 2. Objetivos y no objetivos

**Objetivos**

- Regla "quién pasa" en el modelo, la API, los puntos, la interfaz y las reglas visibles, desplegada **antes de que abra el piloto**.
- Marcador a 90' y equipo que pasa cargados automáticamente desde el primer partido posterior al deploy, con salvaguardas que prefieren dejar un partido **en espera** (sin puntos para nadie) antes que puntuar con un dato dudoso.
- Resultado disponible entre las 2 h 15 min y las 3 h 15 min del inicio (dos pasadas por partido y una corrida de confirmación), no a la mañana siguiente.
- Alerta cuando un partido queda en espera, para que el administrador lo resuelva por excepción.
- Carga manual que gana siempre sobre lo automático; exclusión explícita para resultados administrativos; recálculo automático al leer (como hoy).
- Interruptor de apagado de emergencia.
- Alcance mínimo para llegar a los playoffs en curso (§8).

**No objetivos**

- Período de medición o modo sombra antes de activar (decisión del usuario; el riesgo está en §10).
- Cruces de ida y vuelta: "quién pasa" se define por partido único. Un partido con `leg` (ida o vuelta) no recibe el equipo que pasa automáticamente y no se adopta para fases con la regla (§3 R6).
- Una segunda fuente automática de resultados.
- Automatizar el alta de cruces o la adopción (sigue siendo `POST {adoptar, fase}`), o los cruces manuales: si ESPN trae el mismo partido, el reemplazo de `docs/39` D5 lo convierte en adoptado.
- Notificaciones a participantes y puntos persistidos.
- Actualizar el calendario de los usuarios después del final (la reconciliación sigue siendo diaria, `docs/17`).
- Seguir el horario de ESPN durante el día del partido: en playoffs la fecha es fija; el sync diario alcanza (D8).
- Distinguir postergado de suspendido (`started_at`) y reabrir pronósticos, manual o automáticamente (D7).

## 3. Regla "quién pasa" (R1 a R6)

### R1. Puntos

| Parte | Puntos |
|---|---|
| Marcador a los 90' más el adicionado: exacto | 3 |
| Marcador: no exacto, pero acierta ganador o empate | 1 |
| Marcador: falla | 0 |
| **Extra: acierta qué equipo pasa** (en 90', alargue o penales) | **+1** |

El marcador sigue sin acumular (exacto = 3, no 3 + 1). El extra se suma aparte: un partido da como máximo 4 puntos. Ejemplos: pronóstico 1-1, pasa Boca; termina 1-1 y Boca gana por penales: 3 + 1 = 4. Pronóstico 2-1 a favor del local; termina 1-1 y el local gana por penales: 0 + 1 = 1. Pronóstico 1-0 a favor del local; gana el visitante 2-0: 0 + 0 = 0.

`calcularPuntos` se mantiene con la misma firma para el marcador. Se agrega `calcularExtraPasa(pasaPronostico, pasaReal)` (+1 o 0) y una función `puntosDelPartido` que devuelve `{marcador, extra, total}`. Una regla pura, testeable sin D1.

### R2. El pronóstico: "quién pasa" solo se pide ante un empate

- Si el participante pronostica un ganador, **pasa ese equipo**: se deriva, no se guarda.
- Si pronostica un empate, tiene que elegir quién pasa: `local` o `visitante`.
- Columna nueva `prode_predictions.pasa` (`TEXT`, nullable, valores `home` o `away`), en la migración **0022**. Se guarda solo con empate; con ganador queda `null`.
- `PUT /api/prode/pronosticos` acepta `pasa: "home" | "away"`. Con empate y sin `pasa`: 400 `falta_quien_pasa`. Con un ganador, `pasa` se ignora y se guarda `null` (así cambiar de 1-1 a 2-1 no deja un dato contradictorio). El `INSERT ... SELECT ... ON CONFLICT` atómico de `guardarPronostico` suma la columna sin cambiar su condición de cierre.
- **Por qué `home`/`away` y no el id del equipo**: el pronóstico ya está atado al partido; el reemplazo manual a ESPN (`docs/39` D5) conserva local y visitante (`esMismoCruce` exige el mismo orden), así que el lado no cambia. No hace falta clave foránea ni validar el id.
- **Descartado**: pedir "quién pasa" siempre (es redundante con un ganador y puede contradecirlo); guardar el valor derivado (duplica el dato y obliga a mantenerlo al editar el marcador).

**Compatibilidad**: un empate guardado antes de la 0022 no tiene `pasa` y **no suma el extra**; su marcador puntúa igual que hoy. Como el piloto no empezó, se espera que no haya ninguno. La API devuelve `pasa: null` en esos casos y la interfaz pide completarlo mientras el partido siga abierto.

### R3. El resultado: quién pasó

- Columna nueva `prode_matches.pasa` (`home`/`away`, nullable): corrección manual, en la 0022 (P0a, la regla ya funciona con carga manual). En la **0023** (automatización), `auto_pasa`, la propuesta de ESPN (D2).
- **Equipo que pasó efectivo** (expresión SQL única en `puntos.ts`):
  1. Partido excluido → ninguno.
  2. Si el marcador a 90' efectivo tiene ganador → ese equipo (se deriva; en partido único, quien gana en 90' pasa).
  3. Si fue empate → `pasa` manual; si no hay, `auto_pasa` confirmado (con el automático habilitado); si no, ninguno.
- **Coherencia**: si el marcador a 90' tiene ganador y `pasa` o `auto_pasa` dice lo contrario, el dato es inconsistente. El PATCH lo rechaza (409 `pasa_inconsistente`); el sync no escribe una propuesta inconsistente y deja el partido en espera (D1).

### R4. Un partido puntúa completo o no puntúa

Un partido suma puntos (marcador y extra) solo cuando está `finished`, tiene marcador a 90' efectivo **y** equipo que pasó efectivo. Si falta uno de los dos, queda en espera para todos.

- **Por qué**: un participante que ve "1 punto" y después "4" en el mismo partido no entiende qué pasó; con todo junto hay un solo estado ("esperando el resultado"). En partido único, si el marcador a 90' tiene ganador, el equipo que pasó sale solo, así que la espera solo afecta a los empates.
- **Descartado**: dar el extra por separado cuando ESPN informa quién pasó pero no hay parciales de 90'. Es un punto antes, a cambio de un ranking que cambia dos veces por partido.

### R5. Ranking y desempate

- `puntos` suma el marcador y el extra.
- `exactos` no cambia: marcador exacto a 90'.
- `aciertos` pasa a ser **"acertó el ganador o el empate a los 90'"** (marcador > 0), no "sumó puntos". Hoy son lo mismo (`acierto: puntos > 0`); con el extra dejarían de serlo, y un pronóstico que falló el marcador y solo acertó quién pasa no debe contar como acierto.
- **El extra no entra en el desempate.** Orden: puntos, exactos, aciertos y nombre (`compararParticipantes` sin cambios).
- **Por qué**: el desempate premia la precisión del marcador, que es lo difícil (`docs/37` §6). El extra ya está en los puntos; contarlo otra vez lo pesaría doble. Además, "quién pasa" es muy probable de acertar cuando se acierta el ganador, así que como criterio aparte casi no separaría a nadie. Se agrega un contador `pasa` (aciertos de quién pasa) a `PuntosUsuario` solo para mostrarlo; no ordena.
- **Descartado**: contar el extra como acierto (mezcla dos cosas distintas en la columna "Ac."); un cuarto criterio de desempate por aciertos de quién pasa (cambia la regla publicada sin una razón de juego).

### R6. Interfaz y reglas visibles

- **Formulario (`ProdePronosticos.tsx`)**: cuando los dos goles cargados son iguales, aparece debajo "¿Quién pasa?" con dos opciones grandes (botones de radio con el nombre de cada equipo, alcanzables con el pulgar). Guardar se deshabilita hasta elegir. Con un ganador, el campo no se muestra y se lee "Pasa: <equipo>". El estado "sin cambios" compara también `pasa`. En un partido cerrado se muestra lo elegido; en uno terminado, "Pasó: <equipo>" y los puntos del partido desglosados (por ejemplo "3 + 1").
- **Resumen de reglas** (`src/pages/prode/index.astro`): suma "**+1 punto** si acertás quién pasa (cuentan el alargue y los penales)" y aclara que el marcador sigue siendo el de los 90'.
- **`docs/37`**: §2 suma la fila del extra y el máximo de 4 por partido; §3 separa "qué marcador cuenta" (90') de "quién pasa" (alargue y penales incluidos); §5: cancelado o administrativo no da ni el extra; §6 redefine "aciertos" como en R5 y aclara que el extra no desempata. Se edita en el mismo PR que la regla, no antes (es el texto que ven los participantes).
- **Fases sin partido único**: el endpoint de adopción rechaza un partido con `leg` (ida o vuelta) con 409 `partido_con_vuelta`. Es defensivo: el Clausura es a partido único.

## 4. Salvaguardas en lugar de medición previa

Sin período de medición, la confianza sale de reglas que fallan hacia el lado seguro y de detectar rápido lo que se escape:

1. **Lista blanca de estados** (D1): solo un nombre de estado de ESPN conocido produce un resultado. Un nombre desconocido deja el partido en espera.
2. **Alargue y penales**: el marcador a 90' sale solo de parciales que cierran; el equipo que pasó, del ganador de ESPN coherente con los penales. Si algo no cierra, el partido queda en espera.
3. **Confirmación** (D2): un dato automático puntúa solo cuando se vio igual en dos lecturas separadas por 10 minutos o más, o cuando la primera lectura llega 4 horas o más después del inicio (el sync diario). Así no se puntúa con un dato provisorio del instante del final (**a verificar en el paso 5** si ESPN corrige después; la salvaguarda no depende de eso). Con las pasadas de D4, un partido que termina en 90' se ve en la pasada de +2 h y se confirma en la corrida siguiente (+2 h 15 min); uno con alargue y penales se ve en la de +3 h y se confirma a las +3 h 15 min.
4. **Rango y forma**: goles enteros de 0 a 20, los dos presentes; un solo ganador.
5. **Manual gana siempre y exclusión explícita** (D2).
6. **Alerta de espera** (D5) y **registro de evidencia** (`auto_regla`, log con el nombre de estado) para revisar después cualquier resultado.
7. **Seguimiento sin carga manual** (D5): `metricas.prode.automatizacion.corregidos` cuenta las correcciones manuales que difieren de lo automático. **Criterio de apagado**: una corrección en la regla A, o dos en la regla B, apaga esa regla por KV (D3) hasta analizar la causa con un test rojo.

## 5. Decisiones de la automatización (D1 a D8)

### D1. Marcador a 90' y equipo que pasó desde ESPN: lista blanca y regla conservadora

El adaptador suma a `ProviderMatch` tres campos opcionales: `estadoProveedor` (el `status.type.name` crudo), `goles90` (`{local, visitante, regla: "A" | "B"} | null`) y `pasa` (`"home" | "away" | null`). `mapStatus` no cambia. Los calcula una función pura, `resultadoProde(evento)`:

- **Regla A (fin en los 90').** Si `estadoProveedor` está en `ESTADOS_FIN_REGLAMENTARIO` y `state = "post"`, `goles90` es `competitor.score`. Si hay ganador, `pasa` es ese lado. La lista sale del paso 5 (por ejemplo `STATUS_FULL_TIME` o `STATUS_FINAL`: **a verificar**, ninguno está comprobado en el código). Un empate con un estado de fin reglamentario no debería existir en partido único: da `pasa = null` y espera.
- **Regla B (alargue o penales).** Si el nombre indica alargue o penales (por ejemplo `STATUS_FINAL_AET` o `STATUS_FINAL_PEN`: **a verificar**):
  - `goles90` es la suma de los períodos 1 y 2, **solo** si ESPN publica los parciales por período y los períodos 1 a 4 suman exactamente el marcador final de cada equipo, sin la tanda. Campos candidatos: `competitors[].linescores[].value` y `status.period` (**a verificar**). Si no cierran, `goles90 = null`.
  - `pasa` sale del **ganador que marca ESPN** (`competitors[].winner`, **a verificar**), el dato más confiable del evento: exactamente un competidor con `winner = true`. Si hubo penales, tiene que coincidir con la tanda (`competitors[].shootoutScore`, **a verificar**); si no coincide o falta, `pasa = null`.
- **Coherencia**: si `goles90` tiene ganador y `pasa` dice otro lado, ambos pasan a `null`.
- **Todo lo demás da `null`**: nombres fuera de la lista (resultados administrativos, abandonos), marcadores no numéricos o fuera de rango, eventos sin `state = "post"`, partidos con `leg`.

**Si el paso 5 muestra que algo no se puede asegurar**: sin un nombre de fin reglamentario confiable, no se implementa la regla A y todos los partidos quedan en espera hasta la corrección manual (el flujo de hoy, ahora con alerta). Sin parciales que cierren, el marcador a 90' de los partidos con alargue queda en espera. Es la única excepción manual prevista. Sin un `winner` confiable, el equipo que pasó en un empate también queda en espera. Nunca se completa un dato faltante con una suposición.

- **Por qué una lista blanca**: un nombre nuevo cae en espera en lugar de puntuar mal. Un error de puntaje lo ven todos; una espera, solo el administrador.
- **Descartado**: usar `competitor.score` siempre que `state = "post"` (ya descartado en `docs/39` D3); deducir quién pasó comparando goles con penales sin el `winner` de ESPN (dos campos a interpretar en vez de uno); el endpoint de detalle por evento (una subrequest más por partido y un formato que el repo nunca leyó); reconstruir los 90' con los minutos de cada gol (más frágil que los parciales).

### D2. Columnas propias para lo automático; manual y exclusión ganan (migración 0023)

Columnas nuevas en `prode_matches`, todas nullable:

| Columna | Contenido | La escribe |
|---|---|---|
| `auto_home_goals_90`, `auto_away_goals_90` | `goles90` de ESPN | Solo el sync |
| `auto_pasa` | `pasa` de ESPN (`home`/`away`) | Solo el sync |
| `auto_regla` | `A` o `B`: con qué regla salió (evidencia) | Solo el sync |
| `auto_visto_at` | Primera lectura de los valores actuales (ms). Si cambian, se reinicia | Solo el sync |
| `auto_confirmado_at` | Momento en que se cumplió la confirmación de §4.3 (ms). Si los valores cambian, vuelve a `null` | Solo el sync |
| `excluded_at` | El administrador excluyó el partido: no puntúa (ms) | Solo el PATCH admin |
| `pasada_at` | Última pasada del sync tras el final (ms), D4 | Solo el sync de pasadas |

Si una lectura posterior trae `null`, las columnas automáticas se vacían: el partido vuelve a espera y no conserva un dato que la fuente ya no respalda.

**Marcador a 90' efectivo** (una expresión SQL en `puntos.ts` que reemplaza a `goles90Local/goles90Visitante` y que usan también las métricas):

1. `excluded_at IS NOT NULL` → ninguno.
2. Cruce manual → `matches.home_score/away_score` (como hoy).
3. Corrección manual completa (`home_goals_90` y `away_goals_90`) → la manual.
4. Automático habilitado (D3), par automático completo y confirmado → el automático.
5. Si no → ninguno.

**Equipo que pasó efectivo**: R3, con el mismo orden (excluido; derivado del marcador efectivo; `pasa` manual; `auto_pasa` confirmado). La elección es por par: nunca se mezcla un gol manual con uno automático.

- **Por qué columnas separadas**: el sync nunca escribe `home_goals_90`, `away_goals_90` ni `pasa`, así que no puede pisar una corrección, sin importar el orden en que corran el sync y el PATCH. Como los puntos se calculan al leer (`docs/39` D1), corregir o excluir reordena el ranking sin reprocesar.
- **PATCH admin, solo por excepción**: `{id, homeGoals90, awayGoals90, pasa?}` (los goles, `pasa` o ambos; 409 `pasa_inconsistente` si el marcador tiene ganador y `pasa` lo contradice); `{id, pasa}` para un cruce manual empatado; `{id, excluir: true | false}` sin otros campos (400 `cambios_mezclados`).
- **Cambio de semántica**: hoy `{homeGoals90: null, awayGoals90: null}` deja el partido sin puntuar. Ahora retira la corrección y vuelve a valer el automático. Para que no puntúe se usa `excluir`. Se refleja en `docs/38` (§9).
- **Descartado**: que el sync escriba en las columnas manuales con una marca de origen (tendría que leerla para no pisar una corrección, con la carrera de `docs/39` D6); una tabla de historial (con 15 partidos alcanzan `auto_regla` y los logs).

### D3. Interruptores: KV para emergencias, variable para apagar del todo

- **KV `prode:resultado_auto`** con los valores `on`, `off`, `solo-a` o `solo-b`; sin clave equivale a `on`. **Lo lee solo el sync**, una vez por invocación con partidos del prode. Con `off` el sync no escribe ni confirma datos automáticos; con `solo-a` o `solo-b`, solo los de esa regla. Corta sin deploy; mismo patrón que `ratelimit:modo=off` (CLAUDE.md: KV solo se lee, para el interruptor).
- **Variable `PRODE_RESULTADO_AUTO`** (`on` por defecto; `off` tras un deploy): con `off`, la lectura ignora todo lo automático, incluido lo ya confirmado. Se lee en el handler y se pasa como booleano a `puntosPorUsuario`, `rankingProde` y `getMetricasProde`.
- **Por qué dos niveles**: el KV corta en segundos lo que viene, sin agregar una lectura de KV a cada ranking. Lo ya confirmado y mal se corrige por partido (manual o `excluir`), que gana siempre. La variable es el apagado total, con deploy, como `HTML_CACHE`.

### D4. Dos pasadas por partido tras el final (P1) y el sync diario como respaldo (P0)

**P0, sync diario, sin subrequests de más.** La consulta que `syncPartidos` ya hace por liga suma un `leftJoin` con `prode_matches`. Para cada partido del prode que trae ESPN, el sync agrega al mismo `ejecutarEnLotes` un `UPDATE prode_matches` cuando cambian los datos automáticos o la confirmación. Son unos 15 partidos: entran en el batch que ya existe. A las 06:00 todo partido de la noche anterior tiene más de 4 horas, así que se confirma con una sola lectura. Es el respaldo si una pasada falla o GitHub la saltea.

**P1 (firme), pasadas tras el final: `POST /api/admin/prode/sync`** (Bearer `ADMIN_SECRET`; `withApi` con `rateLimit: []`, como los demás endpoints admin, así que no escribe contadores en D1) y workflow `prode-sync.yml` con `schedule` cada 15 minutos. El repo es público: los minutos de Actions no tienen costo.

**Cuándo hay trabajo.** Cada partido adoptado tiene dos pasadas, a las **+2 h** (un partido que terminó en 90', con el entretiempo y el adicionado) y a las **+3 h** del inicio (alargue y penales). Columna `prode_matches.pasada_at` (0023): la última pasada hecha. Un partido tiene pasada pendiente si, sin estar excluido:

- `ahora ≥ inicio + 2 h` y `pasada_at < inicio + 2 h` (o `null`); o
- `ahora ≥ inicio + 3 h` y `pasada_at < inicio + 3 h`; o
- la pasada anterior vio un dato automático sin confirmar, o el partido seguía `live` (inicio demorado), y `ahora < inicio + 6 h`. Es la corrida de confirmación de §4.3 (15 minutos después) o la espera de un final atrasado.

Pasadas las 6 h sin confirmar, el partido queda para el sync diario y, si sigue sin resultado, entra en la alerta de espera (D5).

**Cada corrida del workflow:**

1. **Consulta de pendientes** (1 lectura): la condición de arriba sobre `prode_matches` unida a `matches` por clave primaria. Si ningún partido tiene una pasada pendiente, responde `{trabajo: false}` sin llamar a ESPN, sin leer KV y sin registrar un run.
2. **KV del interruptor** (D3) y **ESPN**: scoreboard de cada competencia con pasadas pendientes, solo del año de cada partido, con el `pedirJson` existente (3 intentos). Tope: 3 competencias por invocación.
3. **Escritura** en un solo `db.batch`, solo para los partidos pendientes y sin el paso de equipos: cierre (`cerrarEmpezadosDelProde`, sin cambios), `UPDATE` de `matches` con la misma comparación que el sync diario, columnas automáticas y `pasada_at`.
4. **Run** con `kind = 'prode'` (D6), registrado ya terminado: un INSERT y la purga, como `registrarRunCalendarios` (`sync-runs.ts`), en lugar de `startSyncRun` y `finishSyncRun` (4 consultas).

**Corridas reales.** Por partido: 2 pasadas (+2 h y +3 h) y 1 corrida de confirmación 15 minutos después de la pasada que vio el primer dato, más las de un final atrasado si lo hay. Con unos 15 partidos: **unas 45 corridas con trabajo en todo el torneo**. Las otras corridas del workflow (96 por día) solo hacen la consulta de pendientes. Si dos partidos se juegan en paralelo, sus pasadas coinciden en la misma corrida.

- **Por qué pasadas fijas y no una ventana genérica**: el resultado se busca cuando ya puede existir, no durante todo el partido; las corridas con trabajo bajan a 2 o 3 por partido, y el horario no necesita seguimiento durante el día porque en playoffs la fecha es fija (D8).
- **Por qué no `POST /api/admin/sync {leagueId}`**: `syncEquipos` lee todos los equipos de la fuente y `runSync` corre los chequeos de consistencia sobre `matches` entera (`docs/30`) en cada invocación con `leagueId`.
- **Por qué no disparar el Sync diario completo a mano**: un barrido lee de 1 M a 1,5 M de filas, sobre un límite de 5 M por día compartido con staging (memoria del proyecto, `docs/30`). Las pasadas leen decenas de filas.
- **Por qué Actions**: Cloudflare Pages no ejecuta Cron Triggers (comentario de `sync-cron.yml`). GitHub no garantiza la puntualidad de un `schedule`: una pasada atrasada sigue pendiente en la corrida siguiente, porque la condición compara con `pasada_at` y no con la hora exacta.
- **Solo producción**: staging lo corre solo con `workflow_dispatch`.
- **Descartado**: el endpoint de detalle por evento (una subrequest por partido y formato no verificado); un Worker aparte con Cron Trigger (otro despliegue y otros secretos para una función); una ventana de seguimiento continuo (gasta corridas durante el partido sin cambiar cuándo se conoce el resultado).

**Presupuesto de subrequests por corrida** (tope de Workers Free: 50; se usa el margen de 45 de `calendar/presupuesto.ts`). Medido contra el código:

| Concepto | Sin trabajo | Con trabajo, normal | Peor caso |
|---|---|---|---|
| Consulta de pendientes | 1 | 1 | 1 |
| KV del interruptor | 0 | 1 | 1 |
| ESPN: 1 año por competencia, hasta 3 competencias, 3 intentos | 0 | 1 | 9 |
| Leer los partidos pendientes por `external_id` | 0 | 1 | 3 |
| `db.batch` de cambios | 0 | 1 | 3 |
| Registro del run (INSERT y purga) | 0 | 2 | 2 |
| **Total** | **1** | **7** | **19** |

`verificarAdmin` no consulta D1 (`admin-auth.ts` solo recibe KV opcional). **No medido**: si el middleware de Astro hace alguna consulta en una request sin cookie de sesión; se confirma con la D1 instrumentada en el test de presupuesto (§7).

**Cuota de lecturas de D1** (límite de 5 M filas por día, por cuenta, compartido con staging):

- Consulta de pendientes: lee los vínculos de `prode_matches` (decenas de filas) y sus partidos por clave primaria. Estimación: menos de 100 filas por corrida × 96 corridas = **menos de 10 k filas por día**, 0,2 % del límite. **No medido**: depende del plan de consulta de D1. Se confirma con `wrangler d1 insights` (no consume cuota) la primera semana.
- Corridas con trabajo: lectura por `external_id` (índice único) y escrituras de unas pocas filas. Despreciable.
- Sync diario: el `leftJoin` lee las mismas filas de `matches` que hoy, más las de `prode_matches`.
- Staging no corre el workflow por `schedule`, así que no suma lecturas a la cuenta.

La regla "quién pasa" no agrega subrequests ni lecturas: `pasa` viaja en la misma fila de `prode_predictions` y de `prode_matches`.

### D5. Espera, alerta y seguimiento

- **En espera**: adoptado en `finished`, sin exclusión, con `date_time` de hace más de 6 horas (después de la última pasada posible de D4), al que le falta el marcador a 90' efectivo o el equipo que pasó efectivo (R4).
- **Alerta**: `prode-sync.yml`, en las corridas con trabajo, y `sync-cron.yml`, después del sync diario, consultan `/api/admin/status`. Si `metricas.prode.automatizacion.enEspera > 0`, abren un issue `incidente` "Prode: resultados en espera" con `incidente.sh` y lo cierran cuando vuelve a 0. Log `prode_resultado_en_espera` con `{matchId, estadoProveedor, motivo}` (`estado_desconocido`, `parciales_incompletos`, `parciales_no_cierran`, `ganador_incierto`, `inconsistente`, `sin_confirmar`).
- **Qué hace el administrador**: verifica con una fuente oficial y corrige (`PATCH` de D2) o excluye el partido. Es el único caso en que carga datos.
- **Métricas** (`metricas.prode.automatizacion`, agregados sin ids sobre adoptados `finished`): `automaticos` (por regla), `manuales`, `corregidos` (manual distinto del automático, en marcador o en quién pasa), `enEspera`, `excluidos`. El GET admin de partidos suma a cada partido `automatico: {local, visitante, pasa, regla, confirmadoEn} | null`, `pasa` (efectivo), `excluido`, `enEspera` y `pasadaEn`.

### D6. Observabilidad de las pasadas (P1)

- `sync_runs.kind = 'prode'`: la columna es texto (`0011`); solo cambia el tipo `SyncKind`. `checks.sync` de `/api/health` sigue mirando solo `leagues`: si las pasadas se registraran como `leagues`, sus éxitos taparían un sync diario caído. `/api/admin/status` agrega `runsProde`.
- `prode-sync.yml` abre un issue `incidente` "Falla el sync del prode" si una corrida con trabajo falla, y lo cierra al recuperarse.
- Log `prode_sync` con `{partidos, competencias, cambios, confirmados}`. Sin datos personales.

### D7. Postergados y suspendidos: sin cambios de regla (fuera de alcance)

En los playoffs del Clausura hay fecha fija y partido único, así que no se agrega `started_at` ni una reapertura de pronósticos. Rige `docs/37` §5 tal como está:

- **Reprogramado antes de empezar**: sigue abierto hasta la nueva hora si ESPN informa el cambio antes de la hora original (como hoy).
- **Suspendido después de empezar**: queda cerrado (`closed_at`, `docs/39` D4) y no suma puntos hasta completarse. Si se completa otro día y ESPN lo trae en `finished`, se carga solo como cualquier partido (D1).
- **Postergado cuya hora pasó entre dos syncs**: queda cerrado, como hoy (`docs/37`, notas). Es el límite conocido; si ocurriera, el administrador decide con la regla vigente.

La automatización no cambia nada de esto: solo escribe resultados de partidos en `finished` y nunca borra `closed_at`.

- **Descartado**: `started_at` con reapertura manual (resolvía el postergado con la hora vencida, un caso improbable en partido único con fecha fija, a cambio de una excepción al cierre irreversible).

### D8. Horarios y reprogramaciones

El horario de un adoptado lo sigue gobernando ESPN con el sync diario de las 06:00. En playoffs la fecha es fija, así que no se agrega seguimiento durante el día. Las pasadas de D4 también actualizan `matches` (estado y horario) de los partidos que atienden. El cierre sigue en `date_time` (`cierraPronostico`), sin lógica nueva; "quién pasa" cierra junto con el marcador (es la misma fila). Si ESPN mueve un partido ya cerrado a una fecha futura, D4 de `docs/39` lo mantiene cerrado, como hoy. **Consecuencia**: si se reprograma el mismo día, las pasadas se calculan sobre la hora vieja hasta el sync de las 06:00. Se cubre con la regla "seguía `live`" de D4 y con la alerta de espera.

## 6. Suspensiones y reprogramaciones: comportamiento esperado

| Caso | Qué ve el sync (hipótesis de ESPN **a verificar**) | Resultado |
|---|---|---|
| Reprogramado antes de empezar, la hora nueva llega antes de la original | `scheduled` o `postponed` con fecha nueva | Sigue abierto hasta la nueva hora (como hoy); se puede cambiar marcador y quién pasa |
| Postergado antes de empezar, la hora original pasó entre dos syncs | `postponed`, nunca `live` | Cerrado por hora, como hoy (D7) |
| Suspendido en juego | `live` → `postponed`, o un nombre de suspensión | Cerrado; no puntúa hasta completarse (`docs/37` §5); no está en espera (no es `finished`) |
| Suspendido y completado otro día | `finished` en la fecha de reanudación | Datos automáticos si cumplen D1; puntúa |
| Cancelado o abandonado | `cancelled` | No puntúa: ni marcador ni extra |
| Resultado administrativo | nombre fuera de la lista, o un final con marcador dado por la organización | Fuera de la lista: en espera y alerta, el administrador excluye. Si ESPN lo muestra como un final normal, no se detecta solo (§10) |
| ESPN corrige el marcador o el ganador después del final | `finished` con otros datos | Se reinicia la confirmación; el valor nuevo puntúa al confirmarse. Una corrección manual sigue ganando |
| ESPN vuelve un `finished` a `live` | `live` | Deja de puntuar hasta volver a `finished` |
| Alargue o penales sin parciales que cierren | nombre de alargue o penales | En espera y alerta; nunca un resultado inventado |
| Penales con `winner` que no coincide con la tanda | nombre de penales | `pasa = null`; en espera y alerta |

## 7. Estrategia de tests (rojo, verde, refactor)

Cada paso empieza con los tests en rojo. Las muestras del paso 5 se guardan como fixtures (`tests/fixtures/espn-prode-*.json`); un caso no observado en datos reales se marca **sintético** en el nombre del test.

| Archivo | Cubre | Prioridad |
|---|---|---|
| `tests/unit/prode/reglas.test.ts` | `calcularExtraPasa` y `puntosDelPartido`: ejemplos de R1 (1-1 + Boca por penales = 4; 2-1 vs 1-1 con el mismo que pasa = 1; ganador fallado = 0); máximo 4; `pasa` derivado del ganador; empate sin `pasa` = sin extra; `compararParticipantes` sin cambios | P0a |
| `tests/integration/api/prode-pronosticos.test.ts` | Empate sin `pasa` → 400 `falta_quien_pasa`; ganador con `pasa` → se guarda `null`; cambiar de 1-1 a 2-1 limpia `pasa`; cierre atómico igual que hoy; pronóstico anterior a la 0022 se lee con `pasa: null` | P0a |
| `tests/integration/api/prode-puntos.test.ts` y `prode-ranking.test.ts` | Extra con `pasa` manual y derivado; R4 (sin equipo que pasó no puntúa); `aciertos` = marcador > 0 (un pronóstico con solo el extra no es acierto); desempate sin el extra; contador `pasa` | P0a |
| `tests/integration/api/prode-partidos.test.ts` | PATCH `pasa` (manual y adoptado); 409 `pasa_inconsistente`; adopción de un partido con `leg` → 409 `partido_con_vuelta` | P0a |
| `tests/unit/prode-ui/logica.test.ts` y `tests/e2e/prode-recorrido.spec.ts` | El campo aparece solo con empate; guardar exige elegir; "Pasa: X" con ganador; desglose "3 + 1" en terminado; sin scroll horizontal en móvil | P0a |
| `tests/unit/espn-resultado-prode.test.ts` (nuevo) | `resultadoProde`: regla A con cada nombre de la lista; nombre desconocido → `null`; parciales que no cierran → `goles90 = null`; `winner` ausente, doble o en contra de la tanda → `pasa = null`; incoherencia marcador/`pasa` → ambos `null`; `leg` → `null`; fuera de rango → `null` | P0b |
| `tests/unit/espn.test.ts` | `estadoProveedor` conserva el nombre crudo; `mapStatus` y `status` no cambian | P0b |
| `tests/integration/api/prode-puntos.test.ts` | Precedencia: excluido > manual > automático confirmado, para marcador y para quién pasa; sin confirmar no puntúa; variable `off` ignora lo automático; nunca mezcla fuentes en un par; `null, null` vuelve al automático; corregir o excluir reordena el ranking | P0b |
| `tests/integration/data-sync.test.ts` | El sync diario escribe y confirma lo automático sin consultas de más; un valor nuevo reinicia la confirmación; `null` vacía lo automático; nunca escribe las columnas manuales; KV `off`, `solo-a`, `solo-b` | P0b |
| `tests/integration/api/prode-partidos.test.ts` | `excluir` y deshacer; `cambios_mezclados` | P0b |
| `tests/observability/metricas.test.ts` | `automatizacion`: `enEspera` (incluye empates sin quién pasa), `corregidos`, conteos por regla, sin ids | P0b |
| `tests/integration/api/prode-sync.test.ts` (nuevo) | Pendientes: a +1 h 59 min no hay trabajo; a +2 h sí; tras la pasada de +2 h no se repite hasta +3 h; dato sin confirmar → corrida siguiente; `live` sigue pendiente hasta +6 h; excluido nunca. Sin pendientes: no llama a ESPN, no lee KV ni registra un run. Con pendientes: estado, horario, cierre, automático y `pasada_at`; tope de competencias; ESPN caído → run `failed`, nada escrito y la pasada sigue pendiente; las filas de la tabla de §6 | P1 |
| `tests/integration/api/prode-sync-presupuesto.test.ts` (nuevo) | Subrequests con la D1 instrumentada y `fetch` simulado, incluido el middleware: ≤ 19 en el peor caso, 1 sin pendientes | P1 |
| `tests/observability/health.test.ts` | `kind = 'prode'` no cuenta para `checks.sync`; `runsProde` | P1 |

Refactor previsto: en P0a, `puntosDelPartido` concentra el cálculo (puntos, exacto, acierto, extra) y `puntos.ts` deja de derivar `acierto` de `puntos > 0`. En P1, extraer de `syncPartidos` el armado de `datos`, la comparación de cambios y las sentencias del prode, para que los dos syncs compartan la misma lógica.

## 8. Plan de implementación, por valor y urgencia

**P0a: regla "quién pasa", antes de que abra el piloto (primer PR).** No depende de ESPN: con la corrección manual ya funciona, y P0b la automatiza.

1. **Migración 0022**: `prode_predictions.pasa` y `prode_matches.pasa`.
2. `reglas.ts` (R1), `pronosticos.ts` y `PUT /api/prode/pronosticos` (R2), `puntos.ts` y `ranking.ts` (R3 a R5), PATCH admin `pasa` y rechazo de `leg` (R6).
3. Interfaz: formulario condicional, desglose de puntos y resumen de reglas en `index.astro` (R6).
4. `docs/37` §2, §3, §5 y §6 (R6) y `docs/38` §3.4 (la corrección de `pasa`).

**P0b: automatización imprescindible para los playoffs (segundo PR, lo antes posible).**

5. **Muestras históricas de ESPN (solo lectura, bloqueante para P0b; puede correr en paralelo con P0a).** Script `scripts/espn-muestras.mjs`, sin escribir en D1, que baja el scoreboard (`dates={año}`, el mismo pedido que el adaptador) de:
   - los playoffs o la última edición con eliminación directa de la liga del torneo (`arg.1`, temporadas anteriores); el script confirma además el slug en que ESPN publica los playoffs de este Clausura (hoy se asume `arg.1`);
   - Copa Argentina (`arg.copa`), Libertadores (`conmebol.libertadores`) y Sudamericana (`conmebol.sudamericana`), de la temporada en curso y la anterior.

   Filtra los eventos terminados y separa los que fueron a alargue y a penales. De cada uno guarda `status.type` (`name`, `state`, `detail` si viene), `status.period`, `competitors[].score`, `competitors[].winner`, `competitors[].linescores` y `competitors[].shootoutScore`, y los contrasta con el resultado conocido de unos 10 partidos de cada tipo (90', alargue y penales).

   **Qué verifica**: (a) qué nombres de estado usa ESPN para el fin en 90', con alargue y con penales (lista blanca de la regla A y disparadores de la regla B); (b) si `score` incluye los goles del alargue y excluye la tanda; (c) si `linescores` trae un parcial por período y si los períodos 1 a 4 suman `score`; (d) si `winner` marca exactamente un ganador y coincide con la tanda; (e) cómo viene un partido suspendido o postergado, si aparece alguno. Lo que no aparezca en las muestras queda sin verificar y su regla no se implementa (D1).

   **Reconfirmación con los primeros partidos reales**: ESPN no tiene contrato de formato. Los primeros partidos de los playoffs se revisan contra el resultado oficial, aunque se hayan cargado solos, y el script se vuelve a correr sobre ellos. Si algo cambió, se apaga la regla por KV (D3) y se corrige con un test rojo.

   Salida, anotada en las notas de este documento: la lista blanca, la viabilidad de los parciales y la confiabilidad de `winner`. Los payloads quedan como fixtures (§7).
6. **Migración 0023** (columnas de D2) y la precedencia de lectura con la variable de D3.
7. **Adaptador**: `estadoProveedor`, `goles90` y `pasa` en `ProviderMatch`; `resultadoProde` con la lista del paso 5.
8. **Sync diario**: `leftJoin`, escritura y confirmación de lo automático, interruptor KV.
9. **`PATCH {excluir}`**, métricas `automatizacion`, campos del GET admin y alerta de espera en `sync-cron.yml`.
10. **Actualizar `docs/38`** según §9.

**P1 (firme): pasadas tras el final, en el mismo ciclo que P0b.** Endpoint `POST /api/admin/prode/sync`, columna `pasada_at` (va en la 0023), refactor compartido con el sync diario, `kind = 'prode'`, test de presupuesto y `prode-sync.yml` con alertas (D4, D6). Mientras no esté, el sync diario de las 06:00 carga los resultados a la mañana siguiente.

Queda fuera de alcance: `started_at` y la reapertura de postergados (D7).

## 9. Cambios a `docs/37` y `docs/38` (en el PR de cada paso, no antes)

`docs/37` es lo que leen los participantes y `docs/38` describe la operación vigente. Si se cambiaran ahora, describirían algo que todavía no existe.

- **`docs/37`, con P0a**: lo de R6.
- **`docs/38` §3.4, con P0a**: el PATCH acepta `pasa` (`home`/`away`) para un empate, en manuales y adoptados, con 409 `pasa_inconsistente`.
- **`docs/38` §3.4, con P0b**: pasa a llamarse "Corregir un resultado". Para un adoptado de ESPN, marcador y equipo que pasó se cargan solos (`docs/40` D1-D2). El PATCH queda para corregir por excepción y gana siempre. `null, null` retira la corrección y vuelve a valer el automático. `{id, excluir: true}` hace que un partido no puntúe (`excluir: false` lo deshace). El cruce manual no cambia, salvo `pasa` en los empates.
- **`docs/38` §3.5, con P0b**: deja de ser una carga partido por partido. El administrador atiende el issue "Prode: resultados en espera" (verifica con una fuente oficial, y corrige o excluye), revisa `metricas.prode.automatizacion.corregidos` y aplica el criterio de apagado de §4.7 con el KV de D3. Se quita la cadencia de controles a los 30 y 60 minutos.
- **`docs/38` §3.6, con P0b**: si ESPN mantiene `finished` con un resultado administrativo, se usa `excluir: true` (ya no "retirar el resultado"), y se deja constancia en la bitácora.
- **`docs/38` §1 y §5**: la checklist suma el campo "quién pasa" (AUTO y verificación MANUAL en celular); §5 suma `metricas.prode.automatizacion` y, con P1, `runsProde`.

## 10. Despliegue, rollback y riesgos

**Despliegue**

- **Migraciones 0022 (P0a) y 0023 (P0b), solo aditivas** (columnas nullable, sin backfill). Van antes del código, como las anteriores (`deploy.yml` y `staging.yml` las aplican primero). Se declaran en "Despliegue y riesgos" de cada PR. Hay que confirmar que los números siguen libres al integrar con `development`.
- **P0a antes de abrir el piloto**: si el piloto abre con la regla vieja y la nueva llega después, los empates ya pronosticados quedan sin `pasa` y sin extra (R2, compatibilidad). Si eso ocurre, el formulario pide completarlo mientras el partido siga abierto.
- **Variable `PRODE_RESULTADO_AUTO`** y **clave KV `prode:resultado_auto`**: sin definir equivalen a `on`.
- **Antes del release de P0b**: correr el sync en staging con un partido del prode ya terminado y comprobar el resultado automático, el equipo que pasó y el ranking.

**Rollback**

- **Regla "quién pasa"** (reversible mientras el piloto no empiece): revertir el código basta; las columnas `pasa` quedan sin uso y los puntos vuelven a 3/1/0. Con el piloto en curso, revertir cambia puntos ya publicados: requiere avisar a los participantes.
- **Automatización, inmediato y sin deploy**: KV `prode:resultado_auto=off` (no entran datos nuevos) y, por cada partido mal puntuado, una corrección manual o `excluir`, que ganan siempre.
- **Automatización, total**: `PRODE_RESULTADO_AUTO=off` y un deploy. Todo adoptado sin corrección manual vuelve a quedar sin puntos.
- **Código de P0b**: revertir basta; antes, retirar la corrección manual (`null, null`) de los partidos excluidos, que con el código anterior volverían a puntuar.

**Riesgos**

- **Nuevo, por automatizar sin período de medición: el primer error es público.** El primer dato automático equivocado (un nombre de estado mal interpretado, parciales mal leídos, un `winner` mal marcado o un resultado administrativo con apariencia de final normal) cambia el ranking que ven todos antes de que alguien lo note. Mitigación: lista blanca, confirmación, espera ante la duda, corrección inmediata que gana siempre, criterio de apagado (§4.7) y la evidencia de `auto_regla`. Lo que queda sin cubrir: un dato malo que pasa todas las reglas se detecta solo si alguien lo reporta o si el administrador lo revisa.
- **La regla nueva multiplica la espera en los empates.** Todo empate a 90' necesita parciales **y** un `winner` confiable. Si ESPN no publica parciales, cada partido que va a alargue o penales queda en espera y lo resuelve el administrador: es la excepción manual prevista, pero en playoffs puede ser frecuente.
- **Formato de ESPN sin contrato.** Si cambian los nombres, los partidos quedan en espera (falla segura, con alerta). Si cambia el significado de un nombre conocido, no se detecta solo.
- **Muestras del paso 5 incompletas.** Si no hay partidos recientes con penales en las muestras, la regla B no se implementa y esos partidos se resuelven por excepción.
- **Comprensión de la regla.** Un participante puede creer que el marcador del prode incluye el alargue porque "quién pasa" sí lo incluye. Mitigación: el texto de R6 separa las dos cosas y el desglose "3 + 1" lo muestra en cada partido.
- **Pasadas salteadas o atrasadas**: GitHub puede atrasar o saltear un `schedule`. La pasada sigue pendiente en la corrida siguiente y, si no hay ninguna, el sync diario la cubre a las 06:00.
- **Reprogramación el mismo día**: las pasadas usan la hora vieja hasta el sync diario (D8). En playoffs con fecha fija es improbable; la alerta de espera lo hace visible.
- **Lecturas de D1**: estimadas en menos de 10 k filas por día para las pasadas (D4), sin medir. Se confirman con `wrangler d1 insights` la primera semana.
- **Calendario**: las pasadas pueden cambiar `date_time`, pero la reconciliación de calendarios es diaria (igual que hoy).
- **Cambio de semántica de `null, null`**: mitigado con `excluir` y la actualización de `docs/38` en el mismo PR.

## 11. Preguntas abiertas para el usuario

Ninguna pendiente. Decisiones ya tomadas por el usuario: carga automática desde estos playoffs, regla "quién pasa" con el +1 fuera del desempate, dos pasadas por partido tras el final con el sync diario como respaldo, y sin reapertura de postergados. Lo que falta saber de ESPN no es una decisión: lo resuelve el paso 5.

## 12. Notas de implementación

_(Se completa al implementar, con los desvíos respecto de este diseño. Falta lo que no sea el paso 5.)_

### Resultado del paso 5

Muestras de ESPN reales (20/11/2026) con `scripts/espn-muestras.mjs` (solo lectura; mismo pedido que el adaptador: `scoreboard?dates={año}&limit=1000`). Slugs `arg.1`, `arg.copa`, `conmebol.libertadores` y `conmebol.sudamericana`, años 2023 a 2026. Fixtures recortados en `tests/fixtures/espn-prode-{fin-90,alargue,penales,ida-vuelta}.json`.

**Playoffs del Clausura.** Se publican en el mismo slug `arg.1`, no en uno aparte. Cambia `season.slug`: `torneo-clausura`, luego `clausura---round-of-16`, `---quarterfinals`, `---semifinals` y `---final` (igual para el Apertura). En 2023 y 2024 `arg.1` trae un solo torneo anual sin playoffs; los de eliminación aparecen desde 2025.

**(a) Estados** (`status.type.name`; todos con `state: post` y `completed: true`):
- Fin en 90': `STATUS_FULL_TIME` (detail `FT`, `period` 2).
- Alargue: `STATUS_FINAL_AET` (detail `AET`, `period` 4, reloj `120'+n'`). En Copa Argentina 2024 apareció además `STATUS_FINAL_AGT` (gol de oro, `period` 3), un solo caso.
- Penales: `STATUS_FINAL_PEN` (detail `FT-Pens`, `period` 5; el reloj no es confiable). 144 partidos en los 4 slugs y 4 años.

**(b) `score`.** Incluye los goles del alargue y excluye la tanda. Contraste: final de la Libertadores 2023, Fluminense 2-1 Boca `AET` (el gol del título fue de John Kennedy en el alargue). En `PEN` el marcador queda en el empate previo (Boca 0-0 Lanús, tanda 4-2). No se pueden separar los goles de 90' de los del alargue con `score`.

**(c) `linescores`.** NO viene: ningún evento terminado de los 16 pedidos lo trae (ni vacío). Las claves de un competitor son `id, uid, type, order, homeAway, winner, form, score, records, team, statistics, advance, shootoutScore, leaders, aggregateScore`. Sin parciales por período no se puede verificar que los períodos 1 a 4 sumen `score` ni obtener el resultado a los 90'. Con el `scoreboard` solo se sabe que hubo alargue (`period` 4 / `AET`) y el marcador final. Queda por probar el endpoint `summary` (sin verificar).

**(d) `winner`.** En partidos de un solo cruce marca exactamente un ganador cuando los goles difieren, y en los 144 `PEN` coincide con el mayor `shootoutScore` (que viene como número en cada competitor; en `arg.*` también `advance`). Ningún partido tuvo dos `winner: true`. Trampas:
1. En la vuelta de una llave (Libertadores y Sudamericana) `winner` indica quién avanza por global, no el ganador del partido: 33 vueltas `FULL_TIME` con marcador empatado y un `winner: true` (p. ej. Pereira 1-1 Independiente del Valle, 2023, nota "advance 2-1 on aggregate"; Palmeiras 0-0 Atlético Mineiro 2023). Hay `aggregateScore` por competitor y `competition.notes[].text`. Para el prode `winner` NO sirve en ida y vuelta; usar `score`.
2. Un empate sin llave trae `winner` falso en los dos.
- Anomalía: Copa Argentina 2024, Chacarita vs Tigre (`AGT`), `score` 1-1 con Chacarita `winner: true` y sin tanda; probablemente el marcador no incorpora el gol de oro. No se pudo confirmar: tratarlo como dato sucio.

**(e) Suspendidos y postergados.** Solo aparecieron dos no jugados: `STATUS_ABANDONED` (detail `Abandoned`, Libertadores 2025, FOR vs COL) y `STATUS_CANCELED` (detail `Canceled`, Sudamericana 2025, UDC vs IND), ambos con `completed: false`. No apareció ningún `STATUS_POSTPONED` ni `STATUS_SUSPENDED`.

**Sin poder verificar.** (1) `linescores` y el resultado a los 90' (probar `summary`); (2) cómo viene un postergado o suspendido real; (3) partidos en vivo (solo se miraron los terminados); (4) `AET`/`AGT` en Copa Argentina de partido único: muestra mínima; (5) ESPN puede reescribir temporadas viejas.

#### Endpoint summary

Prueba con `{BASE}/{slug}/summary?event={id}` (mismo host que el adaptador) sobre 18 partidos terminados: 6 `AET/AGT`, 10 `PEN` y 2 `FULL_TIME` de contraste. Fixtures recortados: `tests/fixtures/espn-prode-summary-{alargue,penales,fin-90}.json`.

**Campos.**
- `header.competitions[0].competitors[].linescores`: SÍ viene, un `{displayValue}` por período (el `scoreboard` no lo trae). `FULL_TIME`: 2 entradas. `AET`: 4. `PEN`: 5, donde la quinta es la tanda. `AGT`: 3.
- `header.competitions[0].status.type.name` (mismo estado que el scoreboard), más `score`, `winner` y `shootoutScore` por competitor.
- `keyEvents[]`: goles con `scoringPlay: true`, `type.type` (`goal`, `goal---header`, `goal---volley`, `penalty---scored`), `period.number`, `clock.displayValue` (`36'`, `90'+5'`, `99'`), `team` y `participants`. En los partidos de Copa Argentina probados `keyEvents` no vino, así que no es una fuente general.

**Marcador a 90': sí se puede, con `linescores`.** Marcador a 90' = suma de las entradas 1 y 2 de cada competitor. En los 18 partidos, la suma de las entradas de juego (sin la tanda) igualó `score`. Contraste con la final de la Libertadores 2023 (Boca `[0,1,0,0]`, Fluminense `[1,0,1,0]`): a los 90' fue 1-1 (Cano 36', gol de Boca a los 72') y Kennedy marcó a los 99' (período 3) para el 2-1 final. Boca 2-3 Huracán 2026: 1-1 a los 90' (Huracán 5', Boca 87'); el alargue trae dos penales de Huracán (94' y 103') y un gol de Boca a los 116'.
- El alargue se distingue por período: `period.number` 3 y 4 en `keyEvents` y las entradas 3 y 4 de `linescores`. El reloj del alargue sigue contando (91' a 120'), y el adicionado de los 90' se muestra `90'+5'` dentro del período 2. Conviene usar el período, no el minuto.
- Los goles de `keyEvents` de períodos 1 y 2 coinciden con `linescores` donde existen: sirven de verificación cruzada.

**Salvedades.**
- En `PEN`, la quinta entrada de `linescores` NO siempre es `shootoutScore`: en 3 partidos de Copa Argentina difiere en 1 (CESP-TIG: entradas 5 y 6 contra `shootoutScore` 4 y 5), y en `arg.1` coincide. Para la tanda usar `shootoutScore` (coincide con el scoreboard); de `linescores` solo los períodos 1 a 4.
- `AGT` (Chacarita-Tigre): `linescores` `[0,1,0]` y `[0,1,0]`, sin gol de oro. Apoya la sospecha de dato incompleto en ESPN; el 90' es 1-1 pero el ganador sigue sin explicarse.
- El orden de `competitors` puede diferir entre `summary` y `scoreboard`: cruzar por `team`/`homeAway`, no por posición.

**Costo.** Una subrequest extra por partido y solo para `AET`, `AGT` y `PEN` (en `FULL_TIME` el marcador final es el de 90'). Basta un barrido incremental de los partidos recién terminados con esos estados.

**Sin verificar.** Que `linescores` ya esté completo en un partido recién terminado o en vivo (solo se probaron terminados con días o años); la tanda en Libertadores y Sudamericana (sin `PEN` en la muestra de summary); alargue en ida y vuelta (global); `summary` de un postergado o suspendido.
