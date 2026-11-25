# 38 - Lanzamiento del prode (piloto)

Tarjeta de Trello "8. Probar y lanzar el piloto". Reúne la checklist de lanzamiento, qué parte cubre cada test automático y qué debe verificar una persona a mano, y el procedimiento operativo del admin. Las reglas del juego están en `docs/37-prode-reglas.md`.

## 1. Checklist de lanzamiento

Leyenda: **AUTO** = lo cubre un test que corre en el CI; **MANUAL** = lo verifica una persona en un celular real (o en staging) antes de abrir el piloto. Los E2E usan el escenario `prode` de `scripts/e2e-server.mjs` (D1 efímera, tres cruces sembrados: abierto, cerrado y terminado 2-1).

| # | Qué se verifica | Cobertura | Dónde |
|---|---|---|---|
| 1 | Ingreso: sin sesión se redirige al login con `next`; con sesión se ve `/prode` y `/prode/grupos` | AUTO | `tests/e2e/prode.spec.ts` |
| 2 | Elegir y guardar el nombre visible (sin email, sin direcciones web) | AUTO (API) / MANUAL (pantalla) | `tests/integration/api/prode-nombre-visible.test.ts`, `tests/unit/prode/nombre-visible.test.ts`. Ningún E2E recorre el formulario "Primero, tu nombre": los usuarios sembrados ya tienen nombre |
| 3 | Crear un grupo y ver el enlace de invitación | AUTO | `tests/e2e/prode-recorrido.spec.ts` (grupo), `tests/integration/api/prode-grupos.test.ts`, `prode-grupos-limites.test.ts` |
| 4 | Unirse con el enlace (otro usuario) y que el dueño lo vea; el invitado no ve el código | AUTO | `tests/e2e/prode-recorrido.spec.ts` (grupo) |
| 5 | Código inválido o repetido: mensaje genérico, unirse es idempotente | AUTO (API) | `tests/integration/api/prode-grupos.test.ts` |
| 6 | Guardar, editar y recargar un pronóstico de un partido abierto | AUTO | `tests/e2e/prode-recorrido.spec.ts` (pronóstico abierto), `tests/integration/api/prode-pronosticos.test.ts` |
| 7 | Cierre: el partido empezado no se edita (interfaz y servidor, 409 `pronostico_cerrado`), cierre en el instante exacto y envío tardío rechazado | AUTO | `tests/e2e/prode-recorrido.spec.ts` (cerrado), `prode-pronosticos.test.ts`, `tests/unit/prode-horario.test.ts` |
| 8 | Puntos: exacto 3, ganador o empate 1, fallo 0; el resultado y los puntos se ven en el partido terminado | AUTO | `tests/e2e/prode-recorrido.spec.ts` (cerrado), `tests/unit/prode/reglas.test.ts`, `tests/integration/api/prode-puntos.test.ts` |
| 9 | Ranking general y de grupo con nombre visible, posición y puntos; desempate; sin emails ni ids | AUTO | `tests/e2e/prode-recorrido.spec.ts` (ranking), `tests/integration/api/prode-ranking.test.ts` |
| 10 | Reprogramación antes de empezar mantiene abierto el partido hasta la nueva hora y mueve el cierre | AUTO (API) / MANUAL (ver el horario nuevo en pantalla) | `tests/integration/api/prode-partidos.test.ts` ("reprogramar un partido postergado antes de empezar"), `tests/unit/prode-horario.test.ts` |
| 11 | Suspendido después de empezar queda cerrado y no se reabre con una fecha futura (`closed_at`) | AUTO (API) | `tests/integration/api/prode-partidos.test.ts` (cierre definitivo), `tests/integration/data-sync.test.ts` |
| 12 | Cancelado o suspendido sin completar: no da puntos a nadie | AUTO (API) | `tests/integration/api/prode-puntos.test.ts` ("no puntúan los partidos sin resultado, cancelados, postergados...") |
| 13 | Resultado a 90 minutos para partidos adoptados de ESPN (el marcador de ESPN no puntúa) | AUTO (API) | `prode-puntos.test.ts`, `prode-partidos.test.ts` (resultado a 90) |
| 14 | Participantes tardíos: quien se suma con el torneo empezado parte en 0 y solo pronostica partidos abiertos | AUTO (API) | `prode-puntos.test.ts` ("quien se suma sin pronósticos parte en 0"), `prode-ranking.test.ts`, `prode-pronosticos.test.ts` (cierre). Sin E2E propio |
| 15 | Celular: sin scroll horizontal en `/prode` y `/prode/grupos` (viewport Pixel 7) | AUTO | `tests/e2e/prode-recorrido.spec.ts` (scroll horizontal), proyectos `desktop` y `mobile` |
| 16 | Celular real: teclado numérico en los goles, botones alcanzables con el pulgar, copiar el enlace, abrir el enlace desde WhatsApp | MANUAL | Ver sección 2 |
| 17 | Abrir el juego para partidos que no comenzaron: el partido del prode aparece y se puede pronosticar solo si no empezó | AUTO (lógica) / MANUAL (staging) | Ver sección 2, punto 8 |

## 2. Verificación MANUAL antes de abrir el piloto

Una persona, con un celular real (Android e iOS si se puede) y dos cuentas distintas, contra staging (`https://development.fisture.pages.dev`) y luego contra producción tras el release.

1. Iniciar sesión por primera vez: aparece "Primero, tu nombre"; guardar un nombre y ver que el email nunca se muestra.
2. Cargar un pronóstico: el teclado del celular es numérico, los botones se tocan sin hacer zoom y el mensaje "Pronóstico guardado." se ve.
3. Crear un grupo, tocar "Copiar enlace" y pegarlo en WhatsApp.
4. Abrir el enlace desde WhatsApp con otra cuenta: la persona queda en el grupo y ve las posiciones.
5. Con el admin: cargar un cruce con horario a pocos minutos, esperar el inicio y comprobar que el campo se deshabilita (la interfaz se actualiza cada 30 s) y que recargar lo muestra cerrado.
6. Reprogramar un cruce abierto con el PATCH de horario y comprobar que el horario nuevo se ve en `/prode`.
7. Comprobar el ranking tras cargar un resultado (sección 3.4): suben los puntos esperados.
8. Con un partido que todavía no comenzó (por ejemplo, un cruce o un partido de ESPN adoptado de la fecha siguiente), comprobar que aparece en `/prode` como abierto y que uno ya empezado aparece cerrado. No abrir el piloto antes de verlo.
9. Revisar que no haya scroll horizontal ni textos cortados en `/prode`, `/prode/grupos` y un grupo con nombre largo.

Qué NO está sembrado en los E2E (no se inventó): el formulario de nombre visible, el flujo de límites de grupo, las reprogramaciones y suspensiones (se prueban por API en `tests/integration/api/prode-partidos.test.ts`), los partidos adoptados de ESPN y las pantallas con más de 100 participantes.

## 3. Procedimiento operativo del admin

Todas las llamadas llevan `Authorization: Bearer <ADMIN_SECRET>` y `Content-Type: application/json`. `<URL>` es `PUBLIC_APP_URL`. Horarios siempre en hora argentina, formato `AAAA-MM-DDTHH:mm` (sin zona).

### 3.1 Cargar cruces

```bash
curl -X POST "<URL>/api/admin/prode/partidos" \
  -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"leagueId":"<id de liga>","homeTeamId":"<id local>","awayTeamId":"<id visitante>","fase":"cuartos","horario":"2026-11-22T21:00","venue":"<sede opcional>"}'
```

`fase`: `octavos`, `cuartos`, `semifinal` o `final`. Responde 201 con el partido. Errores: 400 (`faltan_datos`, `fase_invalida`, `horario_invalido`, `equipos_iguales`), 404 (`liga_inexistente`, `equipo_inexistente`), 409 `cruce_duplicado`. `GET` en la misma ruta lista los partidos del prode.

### 3.2 Adoptar un partido de ESPN

Si el cruce ya lo trajo el sync, el POST responde 409 `cruce_duplicado` con `existente: {id, source: "espn"}`. Ese es el partido a usar:

```bash
curl -X POST "<URL>/api/admin/prode/partidos" -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"adoptar":"<id del partido existente>","fase":"cuartos"}'
```

No toca la fila del partido: horario y estado los gobierna el sync. 409 `ya_en_prode` si ya estaba. Un adoptado no se edita a mano (409 `partido_no_manual`).

### 3.3 Corregir horarios, fase o estado de un cruce manual

```bash
curl -X PATCH "<URL>/api/admin/prode/partidos" -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"id":"<id del cruce>","horario":"2026-11-23T20:30"}'
```

Se puede enviar `horario`, `fase` y `status` (`scheduled`, `live`, `finished`, `postponed`, `cancelled`). Un partido que ya empezó no cambia de horario ni de fase (409 `partido_ya_empezado`): hay que cargar un cruce nuevo. Un cruce que trae el sync no se corrige acá (cambiar su horario es cosa del sync).

### 3.4 Cargar el resultado a 90 minutos

Cuenta el resultado a los 90 minutos más el adicionado, sin alargue ni penales (`docs/37` §3).

- **Cruce manual**: `{"id":"<id>","status":"finished","homeScore":2,"awayScore":1}` (409 `partido_no_empezado` antes de la hora). Si terminó empatado a 90', cargar además quién pasó con `{"id":"<id>","pasa":"home"}` (`home` es el local, `away` el visitante).
- **Partido adoptado de ESPN**: el marcador de ESPN puede incluir alargue o penales, así que no puntúa solo. Cargar el resultado confirmado con el PATCH:

```bash
curl -X PATCH "<URL>/api/admin/prode/partidos" -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"id":"<id del partido>","homeGoals90":1,"awayGoals90":1}'
```

**Quién pasó (`docs/40` R3).** Con ganador a 90' el equipo que pasó se deriva solo. Con un empate hay que cargar `pasa` (`home` | `away`), junto con el resultado (`"pasa":"away"` en el mismo PATCH) o después, solo (`{"id":"<id>","pasa":"away"}`, en manuales y adoptados); `"pasa": null` lo retira. Si el marcador a 90' tiene ganador y `pasa` lo contradice, 409 `pasa_inconsistente`. **Un empate terminado sin `pasa` no puntúa para nadie** (ni el marcador ni el extra) hasta que se cargue. Valor inválido: 400 `pasa_invalido`.

Enteros 0-20, los dos juntos y sin otros campos que `pasa` (400 `cambios_mezclados`). Errores: 409 `partido_no_empezado`, 409 `pasa_inconsistente`, 409 `partido_manual`, 404 `partido_inexistente`. El partido puntúa cuando además está en `finished`. Corregir el resultado reordena el ranking solo (los puntos se calculan al leer).

Adoptar (`{adoptar, fase}`) un partido de ida o vuelta (`leg`) da 409 `partido_con_vuelta`: el "quién pasa" se define por partido único.

### 3.5 Guardia de resultados durante el piloto

**Responsable titular y suplente** pendientes de asignación antes de abrir el piloto. El titular verifica, carga y comprueba la publicación. El suplente cubre ausencias y revisa resultados dudosos o corregidos.

1. **Una hora antes de cada partido.** Revisar en `GET /api/admin/prode/partidos` el cruce, su ID y la hora publicada, y en `/api/admin/status` el último sync de ligas. Para un cruce manual, volver a comprobar el ID si el sync encuentra el mismo partido en ESPN y reemplaza el registro original.
2. **Tras el final del partido.** Confirmar con el acta, la ficha oficial o la cronología del partido el marcador al cierre del tiempo reglamentario. Si hubo alargue, penales o discrepancias, cotejar el marcador parcial con una segunda fuente. Si falta confirmación o el partido quedó suspendido, registrar el caso como pendiente.
3. **Dentro de los 30 minutos de la confirmación, como objetivo.** Cargar por PATCH según el origen (sección 3.4). Comprobar en el GET que el marcador coincide y que el estado es `finished`. Verificar que el resultado se refleja en `/prode` y que el ranking se actualiza cuando hay pronósticos que suman. Tras una corrección, repetir ambas comprobaciones.
4. **A los 30 y 60 minutos del final.** Revisar los cruces que ya terminaron y siguen sin puntuar. El sync de producción corre a las 06:00 de Argentina. Un adoptado con marcador confirmado solo empieza a puntuar cuando el sync trae `finished`, aunque el PATCH ya haya guardado los goles. Si el estado sigue atrasado, usar el disparo manual del workflow **Sync diario** y comprobar el estado al concluir. Si el caso sigue pendiente una hora después del final, escalarlo al suplente y acordar el próximo control. Para una suspensión, revisar cuando la organización confirme si se reanuda.

Registrar en una bitácora la fecha y fase, el ID y el origen del cruce, el marcador confirmado, la fuente y hora de verificación, quién cargó y revisó, y la hora en que se comprobó el impacto en el ranking. Para pendientes o correcciones, anotar el motivo, los cambios y el seguimiento.

### 3.6 Reprogramados, suspendidos y cancelados

- **Reprogramado antes de empezar**: corregir el horario (3.3); el cierre se mueve con él.
- **Suspendido después de empezar**: queda cerrado para siempre (`closed_at`). Si se completa otro día, cargar el resultado final (3.4). Si nunca se completa, no hay que hacer nada: no da puntos.
- **Cancelado**: `status: "cancelled"` en un manual; en un adoptado lo trae el sync. Un resultado dado por decisión administrativa no cuenta (`docs/37` §5).

## 4. Despliegue de las migraciones 0017-0021 y rollback

Las cinco son solo aditivas (`docs/37`, "Despliegue del prode"): `0017_users_display_name`, `0018_prode_grupos`, `0019_prode_pronosticos`, `0020_prode_matches` y `0021_prode_resultado_90`.

Orden, en cada entorno:

1. **Staging**: el push a `development` aplica las migraciones a `fisture-staging` antes de desplegar (`staging.yml`). Verificar `/api/health` y entrar con sesión a `/cuenta` y `/prode`.
2. **Producción**: el PR `development` a `main` dispara `deploy.yml`, que corre la suite completa, aplica las migraciones de D1 y recién después despliega. Si se despliega a mano: `npm run db:migrate:prod` primero, el código después.
3. Smoke posterior: `/api/health` en 200, navegar con sesión a `/prode` y comprobar que carga la lista.

Riesgo conocido: el código nuevo sobre una D1 sin la 0017 responde 500 a todo request con sesión (la sesión lee `users.display_name`). Las 0020 y 0021 también son obligatorias antes del código.

Rollback: revertir el código basta, la base migrada sigue siendo compatible con la versión anterior. No borrar tablas ni la columna salvo que haga falta, y solo con el código anterior ya desplegado: `DROP TABLE prode_predictions`, luego `prode_group_members` y `prode_groups`, y `ALTER TABLE users DROP COLUMN display_name` (las tablas `prode_matches` y sus columnas de la 0021 se quitan igual que las otras; perderían los vínculos y resultados cargados). Un `DELETE FROM users` manual falla si el usuario es dueño de un grupo (`docs/23`).

## 5. Qué mirar en `/api/admin/status`

`GET <URL>/api/admin/status` con Bearer `ADMIN_SECRET`. Durante el piloto, mirar:

- `health`: debe estar en `ok`; `checks.sync` degradado indica que el sync de ligas no corre y por lo tanto horarios y estados de los partidos adoptados pueden estar viejos.
- `runs` (últimos 20 syncs de ligas): que el último haya terminado bien y reciente. Cada sync reemplaza horario y estado de los partidos de ESPN, también los adoptados del prode; si falla, un partido adoptado puede quedar sin el estado `finished` y no puntuar.
- `sessions`: sesiones vigentes y vencidas; sirve para ver que el piloto está entrando gente y que no se acumulan sesiones vencidas.
- `rateLimit`: bloqueos de límite de tasa; un pico durante el cierre de un partido indica presión sobre `PUT /api/prode/pronosticos`.
- `metricas.usuarios`: crecimiento de cuentas.
- `metricas.prode`: métricas agregadas del piloto, sin ids ni datos personales (`lib/observability/metricas.ts`):
  - `gruposCreados`, `participantes` (usuarios distintos con al menos un pronóstico) y `pronosticos`.
  - `participantesPorFase` y `regresanPorFase` (`octavos`, `cuartos`, `semifinal`, `final`). Regresan quienes pronosticaron en esa fase y en alguna anterior, así que en octavos siempre es 0.
  - `integrantesPorGrupo`: `promedio` y `maximo`.
  - `partidos`: `abiertos` y `cerrados` se cuentan por `closed_at`. `conResultado` cuenta los partidos en `finished` con goles a 90 minutos. La brecha entre `cerrados` y `conResultado` puede incluir partidos en juego, suspendidos, cancelados o pendientes de sync o de carga.

Para detectar resultados pendientes de carga, buscar `estado: "finished"` con `resultado: null` en `GET /api/admin/prode/partidos`. Cruzar esa lista con los partidos cuyo final ya se confirmó en la bitácora para detectar también los atrasos de estado en ESPN. Los logs del PATCH quedan como `prode_cruce_corregido` y `prode_cruce_rechazado` (`npx wrangler pages deployment tail`).

## 6. Evaluar el piloto (tarjeta 9)

Los valores de `metricas.prode` son acumulados al momento de la consulta: conviene anotar una foto después de cada fase.

**Cuantitativo.**
- Los participantes por fase muestran cuánta gente juega.
- `regresanPorFase` permite contar cuántos participantes vuelven de cualquier fase previa. Para medir la retención entre dos fases consecutivas, dividir quienes pronosticaron en ambas por quienes pronosticaron en la primera. Los conteos actuales permiten calcularla directamente para octavos → cuartos. A partir de semifinal se necesita el cruce agregado de ambas fases. Si la primera fase del par tuvo cero participantes, la tasa no aplica.
- `integrantesPorGrupo` mide si el prode se juega en grupo o suelto.

**Cualitativo (no es código).** Conversar con 5 a 10 participantes entre fases, incluyendo a quienes dejaron de jugar y a quienes siguieron. Preguntas:
1. ¿Cómo llegaste al prode y qué esperabas?
2. ¿Qué fue lo más fácil y lo más confuso (grupo, pronosticar, ranking, puntos)?
3. ¿Dejaste de pronosticar alguna fase? ¿Por qué?
4. ¿Con quién jugaste? ¿Invitaste a alguien?
5. ¿Lo volverías a usar en otro torneo? ¿Qué cambiarías?
6. ¿El cierre automático o los puntos te parecieron justos?

**Criterios de decisión** (los umbrales son una propuesta a validar):
- **Continuar:** la mayoría de los participantes de octavos vuelve en la fase siguiente, se juega en grupos y los comentarios no marcan bloqueos graves.
- **Modificar:** hay interés pero se cae por una fricción concreta (entrar al grupo, no entender el puntaje, resultados cargados con demora). Se corrige esa fricción y se vuelve a medir.
- **Detener:** pocos participantes, casi nadie regresa y los comentarios no muestran interés ni con arreglos.

Registrar la decisión y su fundamento con las cifras de la última foto.

## Notas de implementación

- Los E2E de `tests/e2e/prode-recorrido.spec.ts` siembran, dentro del escenario `prode` de `scripts/e2e-server.mjs`, una liga inactiva y no destacada (`prode-liga`) con equipos propios, para que ningún otro test ni lista pública vea los cruces. Cada usuario `prode` tiene nombre visible único, un pronóstico exacto sobre el partido terminado y un grupo propio; el escenario `prode-invitado` aporta el segundo usuario.
- Los tres proyectos de usuarios (`desktop`, `mobile`, `webkit-mobile`) y los dos reintentos tienen sus usuarios sembrados; la configuración de Playwright corre `desktop` y `mobile`.
