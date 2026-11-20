# 37 - Reglas del prode de playoffs del Clausura

Estas son las reglas que verán los participantes del prode de los playoffs del Torneo Clausura. Son el primer paso del prode (tarjeta de Trello "1. Definir las reglas del prode"): todavía no hay base de datos ni pantallas, solo las reglas y su lógica en `src/lib/prode/reglas.ts` (`calcularPuntos` y `compararParticipantes`, con tests en `tests/unit/prode/reglas.test.ts`).

## 1. Cómo se juega

Antes de cada partido de los playoffs pronosticás el resultado: cuántos goles hace cada equipo. Podés cambiar tu pronóstico todas las veces que quieras mientras el partido siga abierto.

## 2. Puntos por partido

| Tu pronóstico | Puntos |
|---|---|
| Resultado exacto (por ejemplo, dijiste 2-1 y salió 2-1) | **3** |
| No es exacto, pero acertaste quién gana o que empatan (dijiste 1-0 y salió 3-1; dijiste 0-0 y salió 2-2) | **1** |
| Fallaste el ganador o el empate | **0** |
| No pronosticaste | **0** |

Los puntos **no se acumulan**: un resultado exacto vale 3, no 3 + 1.

## 3. Qué resultado cuenta

Cuenta el resultado **al final de los 90 minutos más el tiempo adicionado**. No cuentan el alargue ni los penales: si un partido termina 1-1 y se define por penales, el resultado del prode es 1-1 (empate), aunque un equipo avance de ronda.

## 4. Cierre de los pronósticos

Cada pronóstico **cierra cuando empieza su partido** (la hora de inicio publicada en Fisture). Desde ese momento no se puede crear ni cambiar. Cada partido cierra por separado: que haya empezado uno no cierra los otros de la misma fecha.

## 5. Partidos suspendidos, reprogramados y cancelados

- **Reprogramado (antes de empezar)**: el partido sigue abierto hasta su **nueva** hora de inicio. Tu pronóstico se mantiene y lo podés cambiar hasta entonces.
- **Suspendido después de empezar**: el pronóstico queda cerrado tal como estaba. Si el partido se completa otro día, cuenta el resultado final de los 90 minutos más el adicionado de ese partido completo. Hasta que se complete, no suma puntos.
- **Cancelado, o suspendido y nunca completado**: el partido **no da puntos a nadie** (0 para todos). Si la organización da un resultado por decisión administrativa (por ejemplo, un partido dado por perdido), ese resultado no cuenta para el prode: el partido se trata como cancelado.

## 6. Ranking y desempate

El ranking suma los puntos de todos tus pronósticos. Si dos o más participantes empatan en puntos, se ordenan así:

1. Más **resultados exactos**.
2. Más **aciertos** (todo pronóstico que sumó puntos: exactos y de ganador o empate).
3. Si siguen igualados, **orden alfabético por nombre visible** (sin distinguir mayúsculas ni tildes). Es solo para mostrar la tabla: si todo coincide, comparten la posición.

**Por qué esta regla.** Premia primero la precisión, que es lo más difícil del prode (un exacto vale el triple que un acierto). Después premia la regularidad: entre dos que sumaron lo mismo con los mismos exactos, quien acertó más partidos fue más constante. Los tres criterios se calculan solo con datos que ya tiene el prode y cualquiera puede verificarlos en la tabla. El nombre visible al final da un orden estable y predecible sin inventar un mérito; por eso no define premios por sí solo (comparten la posición). Se descartaron criterios como la fecha de inscripción o la hora en que se cargó el pronóstico: castigan a quien se suma tarde o a quien espera la formación, y son difíciles de explicar.

## 7. Sumarse con el torneo empezado

Te podés sumar en cualquier momento. Empezás con **0 puntos** y podés pronosticar todos los partidos que **sigan abiertos**. Los partidos que ya empezaron o terminaron no se pueden pronosticar ni recuperar.

## Notas de implementación


- **`getSessionUser` no se desacopla de `users.display_name`.** Hace `select` de `users` completo y `cuenta.astro` lee `user.displayName` del resultado; una selección explícita sin esa columna rompería ese consumidor (y el tipo `User`). Por eso el orden de despliegue es la defensa: las migraciones van antes que el código (ver "Despliegue del prode"). Con el código nuevo sobre una D1 sin la 0017, todo request con sesión da 500.
- **Partidos del prode = vínculo `prode_matches` (migración 0020).** Un partido es del prode si tiene fila ahí (cruce manual o partido de ESPN adoptado con `POST {adoptar, fase}`); la fase sale del vínculo. Si el sync de ESPN trae después un cruce cargado a mano (misma liga y equipos, a menos de 6 h), lo reemplaza en un batch: pasa vínculo y pronósticos al de ESPN y borra el manual. Limitación: el registro de `calendar_syncs` del manual se borra en cascada, así que quien tenía ese evento en su calendario lo conserva huérfano y puede recibir el del partido de ESPN como uno nuevo.
- **Resultado a 90 minutos (migración 0021, §3).** El marcador de ESPN puede incluir alargue, penales o un resultado administrativo, y ESPN da por terminado (`post`) cualquier partido cerrado. Por eso un partido adoptado de ESPN puntúa solo con el resultado confirmado a mano en el vínculo (`prode_matches.home_goals_90` / `away_goals_90`) y con el partido en `finished`; sin ese resultado queda a la espera. Un cruce manual sigue puntuando con `matches.home_score/away_score` (ya es el de 90'). Si el sync reemplaza un manual terminado, su resultado pasa al vínculo. **Flujo operativo: para partidos de ESPN, cargá el resultado a 90 minutos** con `PATCH /api/admin/prode/partidos {id, homeGoals90, awayGoals90}` (enteros 0-20; 409 `partido_no_empezado` antes del horario, 409 `partido_manual` en un manual, 404 `partido_inexistente` si no está en el prode, 400 `cambios_mezclados` si viene con otros campos). No toca la fila de `matches`.
- **Reprogramar un postergado cuya hora ya pasó: sigue rechazado (§5).** No hay forma de distinguir un `postponed` que nunca empezó de uno suspendido a mitad de partido: `matches` no guarda el historial de estados y pasar a un estado que no es `finished` borra los goles. Hasta tener ese dato (p. ej. una columna `started_at`), cambiar el horario de un postergado solo se permite antes de su hora guardada; si ya pasó, se carga un cruce nuevo.

## Despliegue del prode

Cinco migraciones, todas **solo aditivas** (el código anterior no las lee y sigue funcionando con la base migrada):

| Migración | Efecto |
|---|---|
| `0017_users_display_name` | `ALTER TABLE users ADD COLUMN display_name TEXT` (nullable) |
| `0018_prode_grupos` | tablas `prode_groups` y `prode_group_members` (`owner_id` es `RESTRICT`) |
| `0019_prode_pronosticos` | tabla `prode_predictions` (PK `(user_id, match_id)`) |
| `0020_prode_matches` | tabla `prode_matches` (vínculo partido-fase, PK `match_id`) con backfill de los cruces `source = 'manual'`. **Obligatoria antes del código**: sin ella el listado, los pronósticos y los puntos fallan |
| `0021_prode_resultado_90` | columnas nullable `home_goals_90`, `away_goals_90` y `closed_at` en `prode_matches`. **Obligatoria antes del código** |

**Orden obligatorio: migraciones ANTES del deploy del código**, en cada entorno.

- Producción: `deploy.yml` aplica las migraciones de D1 antes de desplegar el artefacto; si se despliega a mano, correr `npm run db:migrate:prod` primero.
- Staging (`fisture-staging`, `docs/26`): aplicar las migraciones a esa D1 antes del push a `development` que trae el código del prode (`npx wrangler d1 migrations apply fisture-staging --remote --env preview`, como hace `staging.yml`; el push a `development` ya las aplica antes de desplegar); si no, el sitio de staging responde 500 a toda petición con sesión.
- Verificación: `/api/health` y una navegación con sesión (por ejemplo `/cuenta`) tras el deploy.

**Rollback.** Como son aditivas, revertir el código basta: la base migrada sigue siendo compatible con la versión anterior. No se borran las tablas ni la columna (perderían nombres, grupos y pronósticos). Si hubiera que quitarlas, hacerlo recién con el código anterior ya desplegado y en este orden: `DROP TABLE prode_predictions`, `prode_group_members`, `prode_groups`; `ALTER TABLE users DROP COLUMN display_name`. Atención: `DELETE FROM users` manual falla si el usuario es dueño de un grupo (`docs/23`, `docs/14`).
