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

