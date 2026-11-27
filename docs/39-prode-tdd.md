# 39 - Prode de playoffs: diseño (TDD)

> **TDD retroactivo: se escribió después de la implementación piloto para dejar el diseño y las decisiones registradas.** CLAUDE.md pide el TDD antes del código; acá no ocurrió así. Las reglas del juego están en `docs/37-prode-reglas.md`; la checklist de lanzamiento, el procedimiento del admin y la evaluación del piloto, en `docs/38-prode-lanzamiento.md`. Este documento no los repite: registra por qué el sistema quedó como quedó.

## 1. Contexto y problema

Fisture sincroniza partidos con el calendario de cada usuario. Para los playoffs del Clausura se quiso un prode: cada participante pronostica el marcador de cada cruce antes de que empiece, suma puntos al cerrarse el partido y se compara en un ranking general y en grupos privados de amigos. Es un piloto: hay que medir si la gente lo usa (`docs/38` §6) sin comprometer el resto de la app.

Restricciones de la plataforma: Workers Free (50 subrequests por invocación), D1 con cuota de lecturas compartida con staging, sin cola ni cron propio para el prode, y un sync de ESPN que reemplaza horario, estado y goles de los partidos que trae.

Problemas que el diseño tiene que resolver:

- Los datos de ESPN pueden no traer un cruce a tiempo (o traerlo con otro horario), y el marcador de ESPN puede incluir alargue o penales.
- Un pronóstico no puede aceptarse después del inicio, ni siquiera por una carrera entre el usuario, el admin y el sync.
- Hay datos de personas (nombres, grupos, quién juega con quién) que no deben filtrarse.

## 2. Objetivos y no objetivos

**Objetivos**
- Pronosticar goles por partido hasta el inicio; puntos 3/1/0 (`docs/37` §2); ranking general, por fase y por grupo con desempate fijo.
- Grupos privados por código de invitación; el único dato visible de un participante es el nombre visible.
- Carga manual de cruces por el admin y adopción de partidos que ya trajo ESPN.
- Evitar consultas por usuario o partido en el cálculo de puntos. La cantidad de filas leídas crece con los pronósticos del filtro. El sync tiene un tope para los reemplazos del prode (D5).
- Métricas agregadas del piloto sin ids (`/api/admin/status`).
- Solo aditivo en la base: el código anterior sigue funcionando sobre la base migrada (rollback = revertir código).

**No objetivos**
- Premios, pagos o apuestas; el empate de ranking comparte posición (`docs/37` §6).
- Cargar el resultado a 90' automáticamente desde un proveedor (queda manual, ver riesgos).
- Notificaciones, recordatorios, otros torneos, expulsar integrantes, renombrar o borrar grupos.
- Cobertura E2E del formulario de nombre, de adoptados de ESPN ni de pantallas con más de 100 participantes (`docs/38` §2).

## 3. Modelo de datos (migraciones 0017-0021)

| Migración | Contenido |
|---|---|
| 0017 | `users.display_name` (nullable, sin unicidad) |
| 0018 | `prode_groups` (`invite_code` único, `owner_id` RESTRICT) y `prode_group_members` (PK `(group_id, user_id)`, cascade) |
| 0019 | `prode_predictions`, PK `(user_id, match_id)`, cascade con usuario y partido |
| 0020 | `prode_matches` (`match_id` PK, `fase`, `created_at`), con backfill de los cruces `source = 'manual'` |
| 0021 | `prode_matches.home_goals_90`, `away_goals_90`, `closed_at` (todas nullable) |

Código en `src/lib/prode/`: `reglas.ts` (lógica pura), `horario.ts` (hora argentina y cierre), `partidos.ts` (cruces, adopción, corrección), `pronosticos.ts`, `puntos.ts`, `ranking.ts`, `grupos.ts`, `nombre-visible.ts`. API en `src/pages/api/prode/*` (usuario con sesión) y `src/pages/api/admin/prode/partidos.ts` (Bearer `ADMIN_SECRET`). Parte del prode en el sync: `src/lib/data-providers/sync.ts`. Métricas: `getMetricasProde` en `src/lib/observability/metricas.ts`.

## 4. Decisiones

### D1. Puntos calculados al leer, no persistidos
`puntosPorUsuario` (`puntos.ts`) une `prode_predictions` con los partidos `finished` con resultado a 90' y calcula con `calcularPuntos`. No hay tabla de puntos ni columna de puntos en el pronóstico.
- **Por qué**: corregir un resultado (PATCH admin) reordena todo sin reprocesar; no hay datos derivados que se desfasen del resultado, y menos escrituras en D1. El costo es de lectura: `puntosPorUsuario` hace una consulta fija (dos con filtro de grupo) y `rankingProde` suma una más para los nombres (dos en total, tres con grupo); nunca una por usuario o partido.
- **Posibilidad técnica sin evaluación registrada**: persistir los puntos por partido, en `prode_predictions` o en una tabla aparte. Ambas variantes tendrían que actualizar los puntos al cerrar el partido y mantenerlos al día cuando se corrija un resultado.
- **Consecuencia**: las filas leídas crecen con los pronósticos del filtro. `rankingProde` calcula y ordena el ranking completo antes de que `recortarRanking` limite la respuesta a 100 filas (`TOPE_RANKING`, con la fila propia en `yo`).

### D2. El vínculo `prode_matches` en vez de depender de `matches.source`
Un partido es del prode si tiene fila en `prode_matches`; la fase vive ahí. Los cruces manuales se backfillean en la 0020; los de ESPN se suman con `POST {adoptar, fase}`.
- **Por qué**: al principio "del prode" era `source = 'manual'`. Pero el sync de ESPN puede traer el mismo cruce, y `matches.round` es del proveedor (no es la fase del prode). El vínculo desacopla "qué es del prode" de "quién gobierna la fila".
- **Descartado**: columna `is_prode`/`fase` en `matches` (toca una tabla caliente y la pisa el sync); forzar todo a manual (duplica partidos y pierde horarios y estados reales de ESPN).
- Un adoptado no se edita a mano (409 `partido_no_manual`): lo gobierna el sync. Un duplicado (misma liga, mismos equipos en el mismo orden, a menos de 6 h exactas, `VENTANA_DUPLICADO_MS`) da 409 `cruce_duplicado` con el `existente`; ida y vuelta (más de 6 h) o equipos invertidos no cuentan.

### D3. Resultado a 90' manual para los adoptados de ESPN
El adaptador toma el marcador agregado de ESPN, que puede incluir alargue, penales o un resultado administrativo. `mapStatus` en `src/lib/data-providers/espn.ts` clasifica primero los estados específicos, como suspendido y cancelado, y trata los demás `post` como `finished`. Por eso, en un adoptado puntúa solo `prode_matches.home_goals_90/away_goals_90` (cargado con `PATCH {id, homeGoals90, awayGoals90}`) y con el partido en `finished`; en un manual puntúa `matches.home_score/away_score` (ya es el de 90'). Esa regla vive en las expresiones SQL `goles90Local`/`goles90Visitante` de `puntos.ts`. Las métricas usan las mismas expresiones de `puntos.ts`.
- **Comportamiento anterior**: la puntuación usaba el marcador de `matches`, incluido el agregado de ESPN para los adoptados. El commit `8057bb3` documenta el cambio para respetar el resultado reglamentario.
- **Posibilidad técnica sin evaluación registrada**: obtener el resultado de los parciales del proveedor. `ProviderMatch` hoy expone solo los goles agregados. Habría que comprobar que los parciales permiten identificar los 90 minutos más el adicionado, y transmitir ese dato desde el adaptador.
- **Costo**: un paso manual obligatorio por partido adoptado; sin él, el partido queda a la espera y no puntúa.

### D4. Cierre irreversible (`closed_at`) y escritura atómica del pronóstico
- Una vez observado que el partido empezó, `closed_at` queda fijado y no se borra. `cierraPronostico` (`horario.ts`) cierra si hay `closed_at`, si el estado no es `scheduled`/`postponed`/`null`, o si ya pasó la hora exacta (`cierraEn`, con segundos; `iso` está truncado al minuto solo para mostrar).
- **Por qué**: el sync pisa horario y estado con los de ESPN; un partido suspendido a mitad de juego que ESPN pasa a `postponed` con fecha futura reabriría los pronósticos (`docs/37` §5). Sin historial de estados en `matches`, `closed_at` conserva el cierre ya observado.
- **Quién lo fija**: el sync añade una sentencia de cierre al principio de la tanda de cambios de la liga, antes de actualizar los partidos. Si la tanda supera 50 sentencias, `ejecutarEnLotes` la divide en varios `db.batch`. El PATCH de cruces manuales invoca `cerrarSiEmpezo` antes y después del cambio, en el mismo `batch`. El PATCH que confirma el resultado a 90' también fija `closed_at`.
- **Escritura**: `guardarPronostico` primero chequea con `cierraPronostico` (respuesta rápida) y luego escribe con un único `INSERT ... SELECT ... FROM matches JOIN prode_matches WHERE closed_at IS NULL AND status IS NULL/scheduled/postponed AND date_time*1000 > ahora ... ON CONFLICT DO UPDATE`. Si la condición de escritura falla, `meta.changes = 0` y la API responde 409 `pronostico_cerrado`. La sentencia comprueba el estado, el cierre y el horario vigentes contra la hora del servidor capturada justo antes de llamar a `db.run`. El tiempo que pueda pasar entre esa captura y la ejecución de D1 queda fuera de la comparación.
- **Implementación anterior**: la validación se hacía solo en el `SELECT` previo. El commit `de5fd39` documenta la carrera con el UPSERT y añade la condición en la escritura.
- **Posibilidad técnica sin evaluación registrada**: un cron que marque cierres. Por sí solo, aplicaría el cierre en la siguiente ejecución programada.
- **Límite conocido**: si ESPN pasa un partido de futuro a `postponed` futuro sin que su hora original pase entre dos syncs, no se cierra (no empezó).

### D5. Reemplazo manual a ESPN en el sync, con tope
Si el sync recibe un ID de proveedor nuevo y encuentra un manual de la misma liga con los mismos equipos en el mismo orden y a menos de 6 h (`esMismoCruce`), lo reemplaza en un `db.batch` propio. Inserta el partido del proveedor, cierra el vínculo si el manual ya empezó, traslada el vínculo, los pronósticos y las filas de `calendar_syncs` al partido nuevo, y borra el manual. La reasignación conserva el seguimiento de los eventos de calendario existentes. Al mover el vínculo, copia el resultado a 90' si el manual está `finished` y tiene ambos goles.
- **Por qué**: evitar que el cruce aparezca duplicado y que los pronósticos queden sobre una fila que desaparece.
- **Tope `MAX_REEMPLAZOS_PRODE = 5`** por competencia y por invocación: cada reemplazo es una subrequest y el sync ya opera cerca del presupuesto de Workers Free (`docs/22`). Los restantes quedan como manuales hasta la próxima corrida (se loguea `pendientes`).
- **Colisión de calendario**: si el usuario ya tiene una fila de `calendar_syncs` para el partido de ESPN, el batch conserva esa fila. La fila del manual se borra en cascada al eliminar el partido manual (ver riesgos). Esa colisión es defensiva e inalcanzable en producción: el partido de ESPN tiene un UUID nuevo y se inserta en el mismo batch, así que todavía no tiene filas de `calendar_syncs`. El riesgo real es otro: una fila trasladada en `failed` o `pending` sin `external_event_id` se reintenta con el id del partido nuevo y, si el alta original sí había creado el evento, puede duplicarlo (decisión abierta, §8).
- **Comportamiento anterior**: el sync insertaba una segunda fila para el mismo cruce (`ae27ff4`).
- **Posibilidades técnicas sin evaluación registrada**: conservar dos filas y ocultar una requeriría definir cuál gobierna los datos y las consultas. Cambiar directamente `matches.id` requeriría resolver las referencias de `calendar_syncs`, `prode_matches` y `prode_predictions`, cuyas claves foráneas tienen `ON UPDATE NO ACTION`.

### D6. Carreras y 409 `partido_cambio`
El PATCH de horario, fase o estado lee la fila y luego agrupa las escrituras en un `db.batch` atómico. Los cambios solicitados se aplican si el estado y el horario siguen coincidiendo con lo leído (`WHERE status IS <leído> AND date_time = <leído>`). Si la comparación falla o desaparece la fila, el PATCH devuelve 409 `partido_cambio`. El admin puede volver a leer el cruce y reintentar. El mismo `batch` comprueba el cierre en SQL sobre la fila vigente y puede fijar `closed_at` aunque devuelva 409, por ejemplo si el sync acaba de pasar el partido a `live` (`e276a88`). El reemplazo (D5) también comprueba el cierre y obtiene el resultado a 90' desde la fila manual vigente dentro del `batch` (`e7717fe`, `ff16396`).
- **Posibilidades técnicas sin evaluación registrada**: una transacción interactiva agruparía la lectura y la escritura. Una versión de fila permitiría detectar otros cambios si todos los escritores la actualizaran.

### D7. Privacidad
- El único dato de un participante en rankings y grupos es el nombre visible (`display_name`, 3-24 caracteres; sin emails, sin URLs, sin invisibles ni bidi; sin unicidad; `NOMBRE_GENERICO` = "Participante" si no eligió). Las salidas de ranking e integrantes no llevan email ni ids (`FilaRanking`, `Integrante`).
- El código de invitación (22 caracteres base64url, 128 bits aleatorios, índice único) lo ve solo el dueño (`detalleGrupo`). Unirse: idempotente, mensaje genérico ante un código inválido, con límites `prode_unirse`/`prode_unirse_ip` (10/30 cada 10 min) contra el barrido de códigos.
- Un grupo ajeno o inexistente da el mismo 404 (`GET /api/prode/grupos/[id]`): no revela que existe.
- `withApi` no registra el `userId` en las rutas `/api/prode/*` y loguea el patrón de la ruta, no el path con el id del grupo; los logs del prode llevan solo ids de partido, códigos de error o conteos: `prode_pronostico_guardado`/`_rechazado` (`matchId`, `error`), `prode_ranking` (`alcance`, `fase`, `total`), `prode_grupo_creado`, `prode_grupo_unido`, `prode_invitacion_invalida`, `prode.nombre_visible.guardado`/`.rechazado` (`motivo`) y `prode_cruce_*` (ids de partido y `existenteId`, con códigos de error). Ninguno es dato personal: no llevan nombre, email, código de invitación ni id de usuario o de grupo. Las respuestas son `Cache-Control: no-store`.
- Las métricas son conteos agregados sin ids (`docs/38` §5).

### D8. Tope de grupos atómico, dueño y borrado de cuenta
- `crearGrupo` inserta el grupo con `INSERT ... SELECT ... WHERE (SELECT count(*) ... owner_id = ?) < MAX_GRUPOS_POR_DUENO` (10) y la membresía del dueño con `WHERE EXISTS` en el mismo batch: dos creaciones simultáneas no superan el tope y no queda un grupo sin dueño como miembro. Además hay límite de tasa de creación (10/h por usuario, 30/h por IP). Los grupos a los que solo se une no cuentan.
- `prode_groups.owner_id` es `RESTRICT`: borrar al dueño no debe llevarse al grupo y a sus integrantes. `deleteAccount` (`src/lib/db/account.ts`) pasa antes la propiedad al integrante más antiguo, o borra el grupo si el dueño era el único; un `DELETE FROM users` manual que lo saltee falla (`docs/23`).
- **Descartado**: `CASCADE` (un dueño que se va destruye el juego de los demás) y contar y luego insertar (carrera).

### D9. Posiciones compartidas en el ranking
Desempate: puntos, exactos, aciertos (`compararParticipantes`); el nombre solo ordena la tabla. La posición es de competición estándar (1, 2, 2, 4): comparten posición quienes coinciden en los tres números. El general incluye a quien tiene un pronóstico sobre un partido del prode (de la fase, si se filtra), aunque aún no haya puntuado (figura en 0); el de grupo, a todos los integrantes. Razones del orden: `docs/37` §6.
- **Descartado**: desempatar por fecha de inscripción o por hora de carga del pronóstico (castiga a quien llega tarde o espera la formación).

## 5. Estrategia de tests

Las pruebas de integración incluyen casos de regresión para las carreras del PATCH y los cambios del sync de ESPN.

| Archivo | Cubre |
|---|---|
| `tests/unit/prode/reglas.test.ts` | `calcularPuntos` (3/1/0, sin acumular) y `compararParticipantes` |
| `tests/unit/prode/nombre-visible.test.ts`, `grupos.test.ts` | validación de nombres, código de invitación |
| `tests/unit/prode-horario.test.ts` | hora argentina, cierre en el instante exacto, reprogramación |
| `tests/unit/prode-ui/logica.test.ts` | lógica de las islas |
| `tests/integration/api/prode-nombre-visible`, `-grupos`, `-grupos-limites` | endpoints, 404 uniforme, tope de grupos, idempotencia |
| `prode-pronosticos`, `prode-puntos`, `prode-ranking` | cierre y 409, puntos (incluye cancelados y 90'), ranking, tardíos y empates |
| `tests/integration/api/prode-partidos.test.ts`, `tests/integration/data-sync.test.ts` | cruces, adopción, duplicados, resultado a 90', `closed_at`, `partido_cambio`, reemplazo y tope del sync |
| `tests/e2e/prode.spec.ts`, `prode-recorrido.spec.ts` | ingreso, grupo, pronóstico, cierre, puntos, ranking, sin scroll horizontal (desktop y móvil) |
| `tests/e2e/prode-jornada-ranking.spec.ts` | jornada con la fecha argentina; al guardar, el ranking de la fase visible se actualiza |
| `tests/e2e/critical-flows.spec.ts` (navegación) | el ítem "Prode" de la navegación global lleva a `/prode`, o a login con `next` sin sesión |

La jornada es solo UI (`ProdePronosticos`): agrupa los partidos en Hoy, Próxima fecha, Próximos partidos y Partidos anteriores. No cambia la API ni las reglas. El ranking muestra las columnas Ex. (exactos) y Ac. (aciertos).

**Queda manual** (`docs/38` §2): el formulario "Primero, tu nombre", teclado numérico y pulgar en un celular real, copiar y abrir el enlace desde WhatsApp, ver cerrarse un partido en pantalla y el horario reprogramado, partidos adoptados de ESPN en staging y pantallas con más de 100 participantes.

## 6. Plan de implementación

Hecho en ramas `feat/prode-*` y `fix/prode-*`, integradas con commits `chore(prode): integra ...`. La entrega real es la pila de PRs #109 → #110 → #111 (cada uno apunta a la rama del anterior; #109, a `development`), no solo `feat/prode-integracion`. Las tarjetas son las del tablero de Trello "Fisture: camino a producción", lista "Prode de playoffs (piloto)" (la 10 y la 11 son posteriores al piloto y quedan fuera):

1. **Definir las reglas del prode** (`reglas.ts`, `docs/37`): lógica pura primero, sin base de datos.
2. **Preparar los partidos de playoffs** (`horario.ts`, `partidos.ts`, endpoint admin; luego el vínculo `prode_matches`).
3. **Ingreso y nombre visible** (migración 0017, `nombre-visible.ts`, endpoint y pantalla en `/cuenta`).
4. **Grupos privados e invitación** (0018, `grupos.ts`, endpoints, límites y borrado de cuenta; UI en `/prode/grupos`).
5. **Cargar y editar pronósticos** (0019, `pronosticos.ts`, cierre atómico; UI en `/prode`).
6. **Cargar resultados y calcular puntos** (`puntos.ts`, `mis-puntos`; resultado a 90', 0021).
7. **Mostrar los rankings** (`ranking.ts`, endpoints y componente `ProdeRanking`).
8. **Probar y lanzar el piloto** (E2E de recorrido, `docs/38`).
9. **Medir y evaluar el piloto** (`metricas.prode`, `docs/38` §5-6).

Las migraciones 0020 y 0021 y los fixes de ESPN (D2-D6) llegaron después del primer diseño, cuando se vio que ESPN trae cruces propios. **Orden que habría sido mejor**: definir el vínculo `prode_matches` y `closed_at` desde el paso 2 (los cruces y el sync), antes de pronósticos y puntos, porque esas piezas dependen de él y se reescribieron.

## 7. Despliegue y rollback

Las cinco migraciones son aditivas. **Obligatorio: migrar antes de desplegar el código**, en cada entorno: `getSessionUser` hace `select` completo de `users` y lee `display_name`; sin la 0017, todo request con sesión responde 500. Las 0020 y 0021 también son obligatorias antes del código (listado, pronósticos y puntos las usan).

- **Producción**: `deploy.yml` aplica las migraciones de D1 antes de desplegar el artefacto; a mano, `npm run db:migrate:prod` primero.
- **Staging**: `staging.yml` las aplica a `fisture-staging` antes de desplegar en cada push a `development` (`docs/26`).
- **Verificación**: `/api/health` y navegar con sesión a `/cuenta` y `/prode`.
- **Rollback**: revertir el código basta; la base migrada es compatible con la versión anterior. No borrar tablas ni columnas salvo necesidad y solo con el código anterior ya desplegado: `prode_predictions`, `prode_group_members`, `prode_groups`, `prode_matches`, y luego `users.display_name`. Se pierden nombres, grupos, vínculos y pronósticos. Detalle en `docs/37` y `docs/38` §4.

## 8. Riesgos abiertos

- **Calendario.** El reemplazo traslada el seguimiento al nuevo `match_id`. Si ya hay una fila de calendario de ESPN para el mismo usuario, se conserva esa fila y el borrado en cascada de la fila manual puede dejar huérfano su evento en el calendario externo. Esa colisión es defensiva e inalcanzable en producción (el partido de ESPN, con UUID nuevo, se inserta en el mismo batch). El riesgo real: una fila trasladada en `failed` o `pending` sin `external_event_id` se reintenta con el id del partido nuevo y, si el alta original sí había creado el evento, puede duplicarlo. **Decisión abierta**: cómo reconciliar esas filas (por ejemplo, buscar el evento antes de crearlo).
- **Resultado a 90' manual obligatorio.** Si el admin no lo carga, un adoptado no puntúa. Para detectar una carga pendiente, buscá un adoptado en `finished` con `resultado: null` en el GET admin. La diferencia entre `cerrados` y `conResultado` puede incluir partidos en juego, suspendidos, cancelados o pendientes de sincronización o carga. Para retirar el resultado de un adoptado, enviá `PATCH { id, homeGoals90: null, awayGoals90: null }` sin otros campos. El partido deja de puntuar y conserva su cierre.
- **Postergado ya empezado no distinguible.** `matches` no guarda historial de estados, así que reprogramar un `postponed` cuya hora ya pasó se rechaza (409 `partido_ya_empezado`); hay que cargar un cruce nuevo. Haría falta algo como `started_at`.
- **Tope de grupos** (10 por dueño, sin tope de integrantes ni de grupos a los que uno se une): puede ser corto o largo; las métricas `integrantesPorGrupo` darán el dato.
- **Lecturas de D1.** El ranking recorre todos los pronósticos del filtro, y `getMetricasProde` corre agregados completos sobre `prode_predictions` en cada consulta de `/api/admin/status`. Con la cuota compartida con staging (memoria del proyecto), vigilar si el piloto crece. Mitigación posible: caché del ranking o conteos incrementales.
- **Timeouts de la suite bajo carga.** Los tests de integración usan D1 efímera con Miniflare y `testTimeout`/`hookTimeout` de 20 s (`vitest.config`); en CI cargado o en máquinas lentas pueden expirar sin ser un fallo real.
- **Sync caído.** Sin sync de ligas, horarios y estados de los adoptados quedan viejos y pueden no llegar a `finished` (`docs/38` §5).
- **Cierre por salto de estado** entre dos syncs (límite de D4).

## 9. Notas de implementación

Desvíos respecto del diseño inicial (resumen de `docs/37`, "Notas de implementación"):

- **Vínculo en vez de `source`.** El diseño inicial identificaba los partidos del prode por `source = 'manual'`; pasó a `prode_matches` (0020) al aparecer los cruces de ESPN (D2).
- **Resultado a 90' y `closed_at` (0021).** No estaban en el diseño: surgieron al ver que el marcador de ESPN no es el de 90' y que el sync reabría pronósticos (D3, D4).
- **`getSessionUser` sigue leyendo `users.display_name`.** No se desacopló (`cuenta.astro` consume el campo y el tipo `User`); la defensa es el orden de despliegue (§7).
- **Reemplazo manual a ESPN con tope** `MAX_REEMPLAZOS_PRODE` (5), no previsto, por el presupuesto de subrequests (D5).
- **Carreras de cierre (revisión Codex).** El reemplazo fija `closed_at` y copia el resultado desde la fila manual vigente dentro del batch; el PATCH usa escritura condicional y responde 409 `partido_cambio` (D6).
- **Cierre en el instante exacto.** El cierre usa la hora con segundos de `matches.date_time`, no la truncada al minuto que se muestra (un adoptado a las 21:00:45 cerraba 45 s antes).
- **Tope de grupos.** Pasó de contar y luego insertar a un solo `INSERT ... SELECT` condicional (commit `f8ebf21`), y se sumó límite de tasa.
- **Sin `userId` ni `groupId` en logs** de `/api/prode/*` (commits `6092ddb`, `c071ad7`).
- **Ranking.** Incluye en 0 a quien pronosticó sin resultado confirmado, y la API recorta a 100 filas con la fila propia aparte.
- **Reprogramar un postergado con hora pasada sigue rechazado** hasta tener `started_at` o equivalente (§8).
- **E2E.** Los recorridos siembran una liga inactiva y no destacada (`prode-liga`) para no contaminar otras listas (`docs/38`, notas).
- **Jornada y navegación (solo UI).** `ProdePronosticos` agrupa los partidos por fecha argentina en Hoy, Próxima fecha, Próximos partidos y Partidos anteriores; la navegación global suma "Prode" (`Layout.astro`) y el ranking muestra Ex. y Ac. No cambia la API ni las reglas.
