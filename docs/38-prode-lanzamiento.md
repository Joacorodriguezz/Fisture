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
| 13 | Resultado a 90 minutos y quién pasó de un partido adoptado, cargados solos desde ESPN; el marcador total de ESPN no puntúa; corregir y excluir | AUTO (API) / MANUAL (staging, una vez antes del release) | `data-sync.test.ts` (resultado automático), `prode-puntos.test.ts`, `prode-partidos.test.ts` |
| 14 | Participantes tardíos: quien se suma con el torneo empezado parte en 0 y solo pronostica partidos abiertos | AUTO (API) | `prode-puntos.test.ts` ("quien se suma sin pronósticos parte en 0"), `prode-ranking.test.ts`, `prode-pronosticos.test.ts` (cierre). Sin E2E propio |
| 15 | Celular: sin scroll horizontal en `/prode` y `/prode/grupos` (viewport Pixel 7) | AUTO | `tests/e2e/prode-recorrido.spec.ts` (scroll horizontal), proyectos `desktop` y `mobile` |
| 16 | Celular real: teclado numérico en los goles, botones alcanzables con el pulgar, copiar el enlace, abrir el enlace desde WhatsApp | MANUAL | Ver sección 2 |
| 17 | Abrir el juego para partidos que no comenzaron: el partido del prode aparece y se puede pronosticar solo si no empezó | AUTO (lógica) / MANUAL (staging) | Ver sección 2, punto 8 |
| 18 | Quién pasa: se pide solo con empate, se guarda y se ve en el partido terminado junto con el desglose "3 + 1" | AUTO / MANUAL (celular) | `tests/e2e/prode-recorrido.spec.ts`, `prode-pronosticos.test.ts`, `tests/unit/prode-ui/logica.test.ts` |
| 19 | Aviso "Prode: resultados en espera" cuando un partido queda sin resultado | AUTO (lógica) | `tests/unit/prode-espera.test.ts`, `prode-partidos.test.ts`, `tests/observability/metricas.test.ts` |

## 2. Verificación MANUAL antes de abrir el piloto

Una sola vez antes de abrir el piloto (no se repite por partido). Una persona, con un celular real (Android e iOS si se puede) y dos cuentas distintas, contra staging (`https://development.fisture.pages.dev`) y luego contra producción tras el release.

Antes del release, además: correr el sync en staging con un partido de ESPN adoptado y ya terminado, y comprobar el resultado automático, quién pasó y el ranking (`docs/40` §10).

1. Iniciar sesión por primera vez: aparece "Primero, tu nombre"; guardar un nombre y ver que el email nunca se muestra.
2. Cargar un pronóstico: el teclado del celular es numérico, los botones se tocan sin hacer zoom y el mensaje "Pronóstico guardado." se ve. Con un empate aparece "¿Quién pasa?", se elige con el pulgar y al recargar sigue elegido; con un ganador el campo desaparece.
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

### 3.4 Corregir un resultado

Cuenta el resultado a los 90 minutos más el adicionado, sin alargue ni penales (`docs/37` §3).

**Partido adoptado de ESPN: es automático.** El sync (pasadas tras el final y sync diario) carga el marcador a 90' y quién pasó, y puntúa cuando el dato queda confirmado (`docs/40` D1, D2 y D4). No hay que cargar ni verificar nada. El PATCH queda para corregir por excepción y **gana siempre** sobre lo automático:

```bash
curl -X PATCH "<URL>/api/admin/prode/partidos" -H "Authorization: Bearer $ADMIN_SECRET" -H "Content-Type: application/json" \
  -d '{"id":"<id del partido>","homeGoals90":1,"awayGoals90":1,"pasa":"away"}'
```

- **Retirar la corrección**: `{"id":"<id>","homeGoals90":null,"awayGoals90":null}` borra el marcador y el `pasa` manuales; vuelve a valer el automático.
- **Que un partido no puntúe** (resultado administrativo): `{"id":"<id>","excluir":true}`. Se deshace con `"excluir":false`. Va solo (400 `cambios_mezclados` con otros campos) y vale también para un cruce manual.

**Cruce manual** (no lo trae ESPN, así que se carga a mano): `{"id":"<id>","status":"finished","homeScore":2,"awayScore":1}` (409 `partido_no_empezado` antes de la hora). Si terminó empatado a 90', cargar además quién pasó con `{"id":"<id>","pasa":"home"}` (`home` es el local, `away` el visitante).

**Quién pasó (`docs/40` R3).** Con ganador a 90' el equipo que pasó se deriva solo. En un empate, `pasa` (`home` | `away`) puede ir junto con el marcador o solo (`{"id":"<id>","pasa":"away"}`, en manuales y adoptados); `"pasa": null` lo retira. Si el marcador a 90' tiene ganador y `pasa` lo contradice, 409 `pasa_inconsistente`. **Un empate terminado sin equipo que pasó no puntúa para nadie** (ni el marcador ni el extra). Valor inválido: 400 `pasa_invalido`.

Goles enteros 0-20, los dos juntos (o los dos `null`) y sin otros campos que `pasa` (400 `cambios_mezclados`). Errores: 400 `marcador_invalido`, 400 `excluir_invalido`, 409 `partido_no_empezado`, 409 `pasa_inconsistente`, 409 `partido_manual`, 404 `partido_inexistente`. Un partido puntúa cuando además está en `finished`. Corregir o excluir reordena el ranking solo (los puntos se calculan al leer). El participante ve el resultado, quién pasó y sus puntos solo cuando el partido puntúa.

Adoptar (`{adoptar, fase}`) un partido de ida o vuelta (`leg`) da 409 `partido_con_vuelta`: el "quién pasa" se define por partido único.

### 3.5 Resultados durante el piloto: solo por excepción

La operación es automática: las pasadas tras el final cargan el marcador a 90' y quién pasó el mismo día, y el sync de producción (06:00 de Argentina) queda como respaldo; el ranking se actualiza solo. **No hay controles rutinarios ni verificación de resultados a mano**, ni hace falta designar un responsable titular y un suplente para abrir el piloto. El administrador interviene únicamente ante un aviso.

**Cadencia (`docs/40` D4).** `prode-sync.yml` corre cada 15 minutos y llama a `POST /api/admin/prode/sync`. Cada partido adoptado tiene una pasada a las +2 h y otra a las +3 h del inicio; si el partido sigue en vivo o terminó y todavía no tiene resultado confirmado (le faltan los goles o la segunda lectura), se repite en cada corrida hasta las +6 h. Un partido en 90' puntúa cerca de las +2 h 15 min y uno con alargue y penales cerca de las +3 h 15 min. GitHub puede atrasar o saltear un `schedule`: la pasada sigue pendiente. Para adelantarla: Actions → **Sync del prode** → *Run workflow* (sin pendientes responde `{"trabajo": false}` y no hace nada).

**Cuándo hay aviso.** Después de cada pasada con trabajo (`prode-sync.yml`) y del sync diario (`sync-cron.yml`) se consulta `/api/admin/status`. Si un partido adoptado y terminado lleva más de 6 horas desde su inicio sin marcador o sin equipo que pasó, abre el issue `incidente` **"Prode: resultados en espera"** (GitHub avisa por email). Se cierra solo en la corrida en que ya no queda ninguno. Mientras tanto ese partido no puntúa para nadie.

**Qué hacer con el aviso.**

El motivo `equipos_no_coinciden` indica que ESPN trae el partido con otros equipos o con local y visitante invertidos: no se carga nada y el marcador queda vacío. Verificar el cruce real: corregir en la orientación que muestra el prode (3.4) o excluir.

1. `GET /api/admin/prode/partidos` y buscar `"enEspera": true`. `automatico` muestra lo que se leyó de ESPN (`confirmadoEn: null` si todavía no se confirmó). El motivo queda en el log `prode_resultado_en_espera`.
2. Si falta la confirmación o el summary, puede bastar con el sync siguiente (pasadas las +6 h ya no hay pasadas: disparar el workflow **Sync diario**).

Si lo que falla son las pasadas (issue **"Falla el sync del prode"**), ver `docs/23` §6.
3. Si el dato no llega, tomar el resultado de una fuente oficial y corregir o excluir (3.4). Dejar en el issue el partido, la fuente y lo que se hizo.

**Si alguien reporta un resultado mal puntuado.** Corregirlo o excluirlo (3.4). `metricas.prode.automatizacion.corregidos` cuenta las correcciones que difieren de lo automático: con una en la regla A (fin en los 90') o dos en la regla B (alargue o penales), apagar esa regla con el interruptor KV hasta analizar la causa (`docs/40` §4.7; comandos en `docs/23` §6, "Prode: apagar el resultado automático").

### 3.6 Reprogramados, suspendidos y cancelados

- **Reprogramado antes de empezar**: en un partido adoptado lo trae el sync; en un cruce manual, corregir el horario (3.3). El cierre se mueve con él.
- **Suspendido después de empezar**: queda cerrado para siempre (`closed_at`). Si se completa otro día, un adoptado se puntúa solo cuando ESPN lo trae terminado; un manual se carga a mano (3.4). Si nunca se completa, no hay que hacer nada: no da puntos.
- **Cancelado**: `status: "cancelled"` en un manual; en un adoptado lo trae el sync.
- **Resultado dado por decisión administrativa** (no cuenta, `docs/37` §5): si ESPN mantiene el partido como terminado, `{"id":"<id>","excluir":true}`, y dejar constancia del motivo en el issue o en la bitácora. ESPN puede mostrarlo como un final normal: en ese caso no hay aviso automático.

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
- `runsProde` (últimas 10 pasadas del prode con trabajo): `status` y el error por competencia. No cuentan para `health.checks.sync`. Que no haya runs nuevos entre partidos es normal.
- `rateLimit`: bloqueos de límite de tasa; un pico durante el cierre de un partido indica presión sobre `PUT /api/prode/pronosticos`.
- `metricas.usuarios`: crecimiento de cuentas.
- `metricas.prode`: métricas agregadas del piloto, sin ids ni datos personales (`lib/observability/metricas.ts`):
  - `gruposCreados`, `participantes` (usuarios distintos con al menos un pronóstico) y `pronosticos`.
  - `participantesPorFase` y `regresanPorFase` (`octavos`, `cuartos`, `semifinal`, `final`). Regresan quienes pronosticaron en esa fase y en alguna anterior, así que en octavos siempre es 0.
  - `integrantesPorGrupo`: `promedio` y `maximo`.
  - `partidos`: `abiertos` y `cerrados` se cuentan por `closed_at`. `conResultado` cuenta los partidos en `finished` con goles a 90 minutos. La brecha entre `cerrados` y `conResultado` puede incluir partidos en juego, suspendidos, cancelados, excluidos o en espera.
  - `automatizacion`, sobre los adoptados en `finished`: `automaticos` (puntúan sin intervención, por regla `A` y `B`), `manuales` (con alguna corrección), `corregidos` (de esos, los que difieren de lo leído de ESPN en el marcador o en quién pasó), `enEspera` (el que dispara el aviso) y `excluidos`.

Los resultados pendientes llegan solos por el issue de la sección 3.5; no hace falta buscarlos. Los logs del PATCH quedan como `prode_cruce_corregido` y `prode_cruce_rechazado`, y los del sync como `prode_resultado_en_espera` (`npx wrangler pages deployment tail`). Las pasadas loguean `prode_sync`.

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
