# TDD: Prode (pronósticos de partidos con amigos)

Fecha: 20 de noviembre de 2026. Estado: implementado (ver §0 y §13).

## 0. Aprobación

El pedido de esta tarea dice explícitamente que el TDD se escribe y se implementa en la misma corrida,
sin una revisión intermedia. Ese pedido se toma como la aprobación de este documento (regla «Cambios
grandes: TDD primero» de `CLAUDE.md`). Las dudas que aparecieron se resolvieron con la opción más
razonable y quedan registradas acá (§3) y en las notas de implementación (§13).

Antes de diseñar se buscó trabajo previo en todo el repo y en las 69 ramas remotas
(`git grep -i -E "prode|pron[oó]stic|predicci"` en cada una, más el historial de commits): **no hay
nada**. El prode se diseña e implementa desde cero.

## 1. Contexto y problema

En Argentina el «prode» es un ritual de grupo: los del fútbol 5, la oficina o la familia pronostican
los resultados de la fecha y se pelean la tabla. Hoy se juega con una planilla compartida, un grupo de
WhatsApp donde cada uno manda su pronóstico y alguien que «hace las cuentas» el lunes. Fisture ya tiene
lo difícil de un prode: el fixture de la Liga Profesional, la Libertadores, la Sudamericana, las ligas
de CONMEBOL y Europa, con horarios en hora argentina y resultados que llegan con el sync diario
(`docs/22`). Falta el juego.

### 1.1 Lo que ya existe y se reutiliza

| Necesidad | Ya existe |
|---|---|
| Fixture y resultados por competencia | `matches` (estado, goles, hora) y el sync diario por lotes (`docs/22`) |
| Competencias elegibles | `leagues.is_active` + `is_featured`, orden de `ordenarCompetencias` (`docs/36`) |
| Sesión, login con regreso | `locals.user`, `loginHref(next)` y `safeNext` |
| API con origen, JSON, límites y logs | `withApi` + `lib/rate-limit/policies.ts` (`docs/16`) |
| Identidad visual | Tribuna 90 (`tribuna90.css`): `tb-posiciones`, `tb-duelo`, `tb-recuadro`, `tb-vacio`, `tb-boton` |
| Navegación | `Cabecera.astro` (escritorio) y `BarraInferior.astro` (móvil, 5 destinos) |
| Fechas en hora argentina | `lib/format.ts` (`TZ`, `fechaCorta`, `hora`) |

## 2. Design thinking

Sin acceso a personas en esta corrida, la empatía sale del conocimiento del dominio, de la auditoría
`docs/27` (cómo se usa Fisture: celular, una mano, enlaces que llegan por WhatsApp) y de las
restricciones de la app (resultados una vez por día). Todo lo que sigue son **hipótesis**: §2.5 define
cómo validarlas con gente.

### 2.1 Empatizar: quiénes juegan

- **El organizador (Martín, 34).** Arma el prode del grupo del fútbol 5 todos los torneos. Hoy mantiene
  una planilla, persigue a los que no mandaron el pronóstico y calcula los puntos a mano. *Necesita* que
  sumarse sea un link, que los puntos se calculen solos y no tener que explicar el reglamento.
- **La hincha casual (Sofi, 27).** Entra desde el link que mandaron al grupo, en el celular, en el
  colectivo. Se acuerda del prode media hora antes del partido. *Necesita* cargar la fecha entera en un
  minuto, saber hasta cuándo puede y no perder lo que cargó si se le corta la señal.
- **El competitivo (Nico, 41).** Mira la tabla todos los días y quiere ver qué puso cada uno, pero
  solo cuando ya no se puede copiar. *Necesita* una tabla clara, desempates conocidos y el historial.

Contexto que condiciona el diseño:

- La Liga Profesional juega 14 o 15 partidos por fecha, de viernes a lunes, y la AFA reprograma
  horarios con pocos días. La Libertadores juega martes a jueves. Un prode tiene sentido por competencia.
- El canal es WhatsApp; el dispositivo, el celular (la barra inferior y los 44 px táctiles de `docs/27`).
- Fisture actualiza los resultados **una vez por día** (6:00 de Argentina, `sync-cron.yml`).

### 2.2 Definir: problemas («¿cómo podríamos…?»)

| # | Problema | Señal de éxito |
|---|---|---|
| P1 | …sumarse a un grupo desde un link de WhatsApp con el menor número de pasos | link → login → «Unirme»: 3 toques |
| P2 | …cargar una fecha completa desde el celular sin perder lo cargado | 14 pronósticos en < 1 min, un solo «Guardar», aviso de cambios sin guardar |
| P3 | …dejar claro hasta cuándo se puede pronosticar, y que nadie pueda cargar tarde | hora de cierre por partido visible; el servidor rechaza después del inicio |
| P4 | …que los puntos se calculen solos y se entiendan | reglamento en una línea; cada partido del historial dice cuántos puntos dio y por qué |
| P5 | …mostrar la tabla y lo que puso cada uno sin habilitar la copia | pronósticos ajenos ocultos hasta que empieza el partido |
| P6 | …que los estados raros no confundan | vacíos, errores, postergados, cancelados y «sin resultado todavía» con texto propio |

### 2.3 Idear: alternativas y elección

| Tema | Opciones | Elegida y por qué |
|---|---|---|
| Alcance de un pronóstico | (a) por grupo; (b) **uno por partido y usuario, vale en todos sus grupos** | (b): cargar una sola vez. Con (a) quien juega en 3 grupos carga 3 veces la misma fecha |
| Cierre | (a) toda la fecha cierra con el primer partido; (b) **cada partido cierra al empezar** | (b): más simple de explicar («hasta que empieza») y más justo con las fechas de 4 días |
| Puntaje | (a) **3 exacto / 1 ganador o empate**; (b) 5/3/1 con diferencia de gol; (c) ponderado por fase | (a): es el reglamento más conocido y entra en una línea. (b) y (c) quedan como extensión (§11) |
| Guardado | (a) automático por fila; (b) **botón «Guardar» fijo con contador de cambios** | (b): un solo momento de confirmación y un solo estado de error; con señal mala se reintenta todo junto. (a) genera una request por toque y estados por fila difíciles de anunciar |
| Carga de goles | (a) campo numérico; (b) select 0–9; (c) **campo + botones − / + de 44 px** | (c): 0→1 es un toque; escribir sigue siendo posible; `inputmode="numeric"` y 18 px (sin zoom en iOS) |
| Unirse | (a) **código de 8 letras y link con el código**; (b) invitación por email; (c) QR | (a): el link se comparte por WhatsApp y el código se dicta. (b) exige emails ajenos; (c) no aporta en el celular |
| Grupo | (a) **ligado a una competencia**; (b) varias competencias | (a): la tabla tiene sentido por torneo y el fixture a pronosticar queda acotado |
| Navegación | (a) sexto destino en la barra inferior; (b) **«Prode» en la cabecera** (escritorio: sección; móvil: botón junto a la cuenta) | (b): la barra inferior ya tiene 5 destinos (máximo de Material/iOS y test de `docs/27`) |

### 2.4 Prototipar (baja fidelidad, móvil primero)

```
/prode (con grupos)                 /prode/[id] · Pronósticos            /prode/unirse/[código]
┌──────────────────────────┐        ┌──────────────────────────┐        ┌──────────────────────────┐
│ FISTURE        [Prode][A]│        │ ← Prode   LIGA PROFESIONAL│        │ TE INVITARON A JUGAR     │
│ PRODE                    │        │ LOS DEL CINCO            │        │ LOS DEL CINCO            │
│ ┌──────────────────────┐ │        │ 8 jugadores · vas 3.º    │        │ Liga Profesional         │
│ │Te faltan 5 pronóst.  │ │        │[Pronós.][Tabla][Hist][Gr]│        │ 8 jugadores · organiza   │
│ │El primero cierra hoy │ │        │ Exacto 3 · Ganador 1     │        │ Martín G.                │
│ │21:00   [Cargar →]    │ │        │ ─ SÁB 22/11 ──────────── │        │ Exacto 3 · Ganador 1     │
│ └──────────────────────┘ │        │ RIV [−][2][+] [−][1][+]BOC│        │ [ UNIRME AL PRODE ]      │
│ TUS GRUPOS               │        │ Cierra 21:00 · Guardado  │        │ (sin sesión:             │
│ Los del Cinco  3.º 14pts │        │ RAC [−][ ][+] [−][ ][+]IND│        │  [ INGRESÁ PARA UNIRTE ])│
│ Oficina        1.º 20pts │        │ ...                      │        └──────────────────────────┘
│ [Crear grupo][Tengo cód.]│        │▐ 2 cambios  [ GUARDAR ] ▌│ ← fija sobre la barra inferior
└──────────────────────────┘        └──────────────────────────┘
```

Las pantallas finales siguen Tribuna 90: titulares Anton, volantas rojas, `tb-posiciones` para la
tabla, `tb-recuadro` amarillo para el reglamento y `tb-vacio` para los estados vacíos.

### 2.5 Validar

- **Automático (en esta corrida):** E2E de las tareas P1–P3 en escritorio y Pixel 7; axe WCAG 2.2 AA
  de las pantallas nuevas en ambos temas y tres navegadores (`tests/e2e/ux/audit.spec.ts`); reflow a
  320/375/768/1280 px; controles de al menos 44 px; capturas en `docs/ux-evidence/prode/`.
- **Con personas (pendiente, mismo protocolo que `docs/27`):** cinco hinchas sin experiencia previa,
  celular propio, sin indicar rutas. Tareas: (1) «Te mandaron este link por WhatsApp: sumate»;
  (2) «Cargá la fecha»; (3) «¿Cuántos puntos sacaste en Racing–Independiente y por qué?»; (4) «¿Qué
  puso Martín en el clásico?» (antes y después del inicio); (5) «Armá un prode para la Libertadores e
  invitá a alguien». Medir éxito sin ayuda, tiempo y dudas literales. Meta inicial: 4/5 en (1) y (2).

## 3. Decisiones

### 3.1 Juego

1. **Un pronóstico por usuario y partido** (`prode_predictions`, PK `(user_id, match_id)`), compartido
   por todos los grupos del usuario. La UI lo dice: «Tu pronóstico vale para todos tus grupos de esta
   competencia».
2. **Cierre por partido.** Se puede cargar, cambiar o borrar mientras `matches.status = 'scheduled'` y
   la hora del servidor sea anterior a `date_time`. La guarda vive **en el SQL** del alta
   (`INSERT … SELECT … WHERE status = 'scheduled' AND date_time > ?ahora`): no hay ventana entre
   validar y escribir. Un partido postergado queda bloqueado y oculto; si se reprograma vuelve a abrir.
3. **Puntaje 3/1/0.** Exacto: 3. Ganador o empate: 1. Resto: 0. Cuenta el resultado que informa la
   fuente al terminar (incluye el alargue si lo hubo, no los penales). Cancelados y postergados no
   suman. Las constantes viven en `lib/prode/reglas.ts` y el SQL del sync se arma con ellas; un test
   verifica que el SQL y la función de TypeScript den lo mismo para toda la matriz de casos.
4. **Tabla.** Puntos; desempate por exactos y luego por aciertos (ganador o empate). Si persiste, la
   misma posición (1, 1, 3) y se ordena por fecha de ingreso. Cuentan los partidos de la competencia del
   grupo que empiezan **después de crear el grupo** (`prode_groups.starts_at`). Quien entra tarde suma
   desde que pronostica (su pronóstico pudo ser anterior: no hay ventaja, el cierre es el mismo).
5. **Privacidad entre miembros.** Los demás ven tu nombre como «Nombre I.» (primer nombre e inicial del
   último), tus puntos y tus pronósticos **solo de partidos que ya empezaron**. Nunca el email: sin
   nombre se muestra «Participante». Se agrega a la política de privacidad.

### 3.2 Grupos

6. **Grupo = competencia + nombre + código.** Nombre de 3 a 40 caracteres (sin controles, espacios
   colapsados). Competencia: activa y destacada. Código: 8 caracteres de `ABCDEFGHJKMNPQRSTUVWXYZ23456789`
   (sin I, L, O, 0 ni 1 para poder dictarlo), con `crypto.getRandomValues` y muestreo por rechazo; se
   muestra como «ABCD EFGH» y se acepta con espacios, guiones o en minúsculas. 31^8 ≈ 8,5·10^11
   combinaciones más el límite de intentos de §3.4.
7. **Límites:** 50 miembros por grupo; 20 grupos por usuario. Superarlos responde 409 con un mensaje que
   dice qué hacer.
8. **Administración.** `prode_groups.owner_id` (FK `ON DELETE SET NULL`). Administra el dueño; si no hay
   dueño (borró su cuenta), el miembro más antiguo. El dueño puede regenerar el código (el link viejo
   deja de andar), sacar miembros y borrar el grupo. Cualquiera puede compartir la invitación y salir.
   Si el dueño sale, el grupo pasa al miembro más antiguo; si sale el último, el grupo se borra.
9. **Unirse es una acción explícita.** El link `/prode/unirse/[código]` muestra el grupo y un botón
   «Unirme» (POST). Un GET nunca une a nadie (evita uniones por prefetch o por enlaces maliciosos). Sin
   sesión, el botón lleva a `/login?next=/prode/unirse/[código]` y se vuelve a la misma pantalla.
   Unirse dos veces es idempotente.

### 3.3 Pantallas

10. `/prode`: sin sesión, explicación, reglamento, «Ingresá para jugar» y «¿Tenés un código?»
    (formulario GET, funciona sin JS). Con sesión y sin grupos, estado vacío con crear y unirse. Con
    grupos: aviso de pendientes («Te faltan 5 pronósticos; el primero cierra hoy 21:00»), tarjetas de
    grupos con posición y puntos, crear y unirse. Indexable (es la página de presentación).
11. `/prode/[id]`: requiere sesión y ser miembro (si no, 404 sin revelar que existe). Pestañas como
    enlaces (`?tab=`), igual que la liga en `docs/31`: **Pronósticos** (por defecto), **Tabla**,
    **Historial** y **Grupo**. `noindex`.
12. `/prode/unirse/[código]` (y `/prode/unirse?codigo=`, que redirige): `noindex`. Código inexistente:
    404 con «Ese código no existe o lo cambiaron» y el formulario para escribir otro.
13. **Carga de pronósticos** (`CargarPronosticos.tsx`, `client:visible`): partidos por día, cada uno un
    `<fieldset>` con leyenda accesible, campos con `inputmode="numeric"` y botones − / + de 44 px, hora
    de cierre y estado («Guardado», «Sin guardar», «Cerrado»). Barra fija abajo (sobre la barra inferior
    en móvil) con el contador de cambios y «Guardar». Aviso al salir con cambios sin guardar. Filas que
    llegan a su hora de inicio con la página abierta se bloquean solas. Respuesta parcial: lo que se pudo
    guardar se guarda y cada rechazo se explica en su fila.
14. **Tabla**: `tb-posiciones` con «Vos» destacado (`tb-destacado`), columnas Pts, PE (exactos), PA
    (aciertos) y PJ (pronósticos puntuados), con `<abbr>` para las siglas. Nota: «Los puntos se suman
    cuando cargamos el resultado, a la mañana siguiente del partido».
15. **Historial**: últimos 30 partidos empezados desde la creación del grupo: resultado, tu pronóstico,
    puntos («+3 exacto», «+1 ganador», «0», «Sin resultado todavía», «Cancelado: no suma») y un
    `<details>` «Lo que puso el grupo» (sin JS).
16. **Grupo**: invitación (código, link, «Compartir» con Web Share API o copia, «Enviar por WhatsApp»),
    miembros (organizador marcado), y acciones con confirmación en dos pasos.
17. **Navegación**: «Prode» se suma a las secciones de la cabecera de escritorio. En móvil la barra
    inferior queda como está (5 destinos) y la cabecera muestra un botón «Prode» con ícono de copa entre
    el nombre y la cuenta (solo ícono si no entra). Es el cambio mínimo fuera del prode.

### 3.4 API

Todos los handlers con `withApi` y política explícita de límite (`docs/16`). Las rutas exigen sesión
por el middleware (`/api/prode` no está en `APIS_PUBLICAS`) y además chequean `locals.user`.

| Método y ruta | Cuerpo | Respuestas | Límite |
|---|---|---|---|
| `POST /api/prode/grupos` | `{ nombre, ligaId }` | 201 `{ id, codigo }`; 400 `nombre_invalido` / `liga_invalida`; 409 `limite_grupos` | `mutation_ip`, `prode_crear` (10/h por usuario) |
| `POST /api/prode/unirse` | `{ codigo }` | 200 `{ grupoId, yaEraMiembro }`; 400 `codigo_invalido`; 404 `codigo_inexistente`; 409 `grupo_lleno` / `limite_grupos` | `prode_unirse_ip` (30/10 min por IP), `prode_unirse` (10/10 min por usuario) |
| `PUT /api/prode/pronosticos` | `{ pronosticos: [{ partidoId, local, visitante }] }` (≤ 40; `null`/`null` borra) | 200 `{ guardados, borrados, rechazados: [{ partidoId, motivo }] }`; 400 `cuerpo_invalido` | `mutation_ip`, `prode_pronosticar` (30/min por usuario) |
| `DELETE /api/prode/grupos/[id]` | — | 204; 403 `no_admin`; 404 | `mutation_ip`, `mutation` |
| `POST /api/prode/grupos/[id]/salir` | — | 200 `{ grupoBorrado }`; 404 | `mutation_ip`, `mutation` |
| `POST /api/prode/grupos/[id]/codigo` | — | 200 `{ codigo }`; 403; 404 | `mutation_ip`, `mutation` |
| `DELETE /api/prode/grupos/[id]/miembros/[userId]` | — | 204; 400 `es_vos`; 403; 404 | `mutation_ip`, `mutation` |

Motivos de rechazo de un pronóstico: `cerrado` (empezó, en juego, terminado, postergado o cancelado),
`inexistente` e `invalido` (goles fuera de 0–20, no enteros, o uno solo cargado). Las páginas leen D1
directo (como el resto de la app): no hacen falta endpoints GET.

Regla automática nueva (`CLAUDE.md`, «Errores de agentes»): `descubrimiento.test.ts` falla si un
handler de `pages/api/prode/**` no declara `rateLimit: [...]`.

### 3.5 Puntaje en el sync

18. `puntuarPronosticos(DB, ahora)` (`lib/prode/puntuar.ts`) corre **un solo batch de D1 con dos
    `UPDATE … FROM matches`**: puntúa los pronósticos de partidos terminados con los dos goles cargados
    que no tienen puntos o cuyo partido cambió después de puntuarse (`scored_at < matches.updated_at`,
    corrección del resultado), y anula los puntos de los que dejaron de estar terminados (cancelado o
    corregido). Ventana: partidos de los últimos 30 días (`idx_matches_date`), así el costo no crece con
    la historia.
19. Lo llama `runSync` **en la misma condición que los chequeos de consistencia**: sin lotes, con
    `leagueId`, o en el último lote (`siguienteLote: null`). El último lote tiene 2 competencias (62 en 13
    lotes de 5, `docs/32`), así que suma **1 subrequest** con margen de sobra respecto de los 50 de
    Workers Free (`docs/22` D4). Un fallo del puntaje se loguea (`prode_scoring_failed`) y no falla el
    sync; el siguiente lo recupera. Log `prode_scored` con conteos, sin ids.

## 4. Cambios de datos (migración `0017_prode.sql`)

```sql
CREATE TABLE prode_groups (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  league_id TEXT NOT NULL REFERENCES leagues(id),
  invite_code TEXT NOT NULL,
  owner_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  starts_at INTEGER NOT NULL,        -- segundos: cuentan los partidos desde acá
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX prode_groups_invite_code_idx ON prode_groups (invite_code);

CREATE TABLE prode_members (
  group_id TEXT NOT NULL REFERENCES prode_groups(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX prode_members_user_idx ON prode_members (user_id);

CREATE TABLE prode_predictions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  home_goals INTEGER NOT NULL,
  away_goals INTEGER NOT NULL,
  points INTEGER,                    -- NULL hasta que el sync lo puntúa
  scored_at INTEGER,                 -- segundos
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, match_id)
);
CREATE INDEX prode_predictions_match_idx ON prode_predictions (match_id);
```

Solo aditiva: tablas nuevas, sin tocar las existentes. El código anterior no las lee. Borrar la cuenta
se lleva membresías y pronósticos por cascada; los grupos del usuario quedan sin dueño (§3.2 D8).

## 5. Módulos

- `lib/prode/reglas.ts` (puro): `puntosDe`, `sqlPuntos`, `estadoPartido`, `validarGoles`,
  `normalizarCodigo`, `generarCodigo`, `formatearCodigo`, `normalizarNombreGrupo`, `nombreVisible`,
  `ordenarTabla`, constantes y límites.
- `lib/prode/repo.ts` (D1): grupos (crear, buscar por código, unirse, salir, expulsar, regenerar,
  borrar), pronósticos (guardar en lote, del usuario), tabla, historial con lo del grupo, mis grupos y
  pendientes.
- `lib/prode/puntuar.ts`: el puntaje del sync (§3.5).
- `pages/api/prode/**`: los handlers de §3.4, finos sobre `repo.ts`.
- `pages/prode/**`, `components/islands/prode/*.tsx` y `styles/prode.css` (prefijo `pr-`).

## 6. Estrategia de tests (test primero: rojo, verde, refactor)

**Unit (`tests/unit/prode/reglas.test.ts`)**

- `puntosDe`: exacto, ganador local y visitante, empate acertado, empate errado, invertido.
- `estadoPartido`: abierto, cerrado por hora, en juego, terminado, postergado, cancelado.
- `validarGoles`: enteros 0–20; rechaza negativos, decimales, strings y > 20.
- Código: largo, alfabeto, normalización (minúsculas, espacios, guiones) y rechazo de caracteres ambiguos.
- `nombreVisible`: «Ana Gómez» → «Ana G.», un solo nombre, vacío → «Participante», nunca un email.
- `ordenarTabla`: desempates y posiciones compartidas.

**Integración (D1 efímera)**

- Grupos: crear, límites, unirse idempotente, grupo lleno, salir con traspaso, último sale y se borra,
  expulsar, regenerar invalida el código viejo, borrar solo el admin, admin de respaldo al borrar la
  cuenta del dueño (cascada).
- Pronósticos: alta, cambio, borrado, cierre por hora con reloj fijo, postergado, tope de 40,
  validación, respuesta parcial y la guarda en SQL.
- Puntaje: SQL igual a `puntosDe` en toda la matriz; corrección del resultado; anulación al cancelarse;
  idempotencia; fuera de la ventana no se toca; un solo batch.
- Tabla e historial: desempates, partidos anteriores al grupo excluidos, lo ajeno solo si empezó.
- `runSync`: puntúa sin lotes y en el último lote, no en los intermedios, y un fallo del puntaje no
  falla el sync.
- API: 401 sin sesión, validaciones, caminos felices; descubrimiento exige `rateLimit` en `prode/**`.
- Planes de consulta: el puntaje y la tabla usan índices (sin `SCAN` de `prode_predictions`).
- Esquema: snapshot de drizzle actualizado con las tres tablas.

**E2E (Playwright, escritorio y móvil)** — `tests/e2e/prode.spec.ts`

- Sin sesión: `/prode` presenta el juego y el link de invitación pide login y vuelve.
- Crear un grupo, ver la invitación, cargar un pronóstico, guardar y verlo al recargar.
- Unirse por link y aparecer en la tabla.
- Tabla, historial con lo del grupo y partidos cerrados no editables.
- Administración: regenerar código, sacar a un miembro y borrar el grupo con confirmación.
- UX (`tests/e2e/ux/audit.spec.ts`): axe en ambos temas para las pantallas nuevas, reflow y la barra
  inferior sigue con 5 destinos.

## 7. Plan de implementación

1. Migración 0017, `schema.ts` y snapshot; `reglas.ts` con sus tests.
2. `repo.ts` y `puntuar.ts` con sus tests de integración.
3. Endpoints y regla automática de `rateLimit`.
4. Puntaje en `runSync`.
5. Navegación (cabecera) y páginas: `/prode`, `/prode/unirse`, `/prode/[id]` con sus islands.
6. Política de privacidad.
7. E2E, auditoría UX, capturas y `npm run check`.
8. Notas de implementación y PR.

## 8. Despliegue y rollback

- **Migración 0017**: se aplica sola en el release (`deploy.yml`). Aditiva. Rollback del código sin
  revertir la migración (las tablas quedan sin uso). Para borrarlas a mano: `DROP TABLE` de las tres.
- **Sin variables de entorno nuevas.** Políticas nuevas en `policies.ts`: `prode_crear`,
  `prode_unirse`, `prode_unirse_ip`, `prode_pronosticar`.
- **Staging**: probar en `development.fisture.pages.dev` con dos cuentas (crear, invitar, cargar) y
  disparar el sync para ver el puntaje del día siguiente.

## 9. Riesgos

- **Lecturas D1.** La tabla agrega los pronósticos de los miembros por grupo; `/prode` lo hace para
  todos tus grupos en un solo batch. Con 50 miembros × ~300 partidos son ~15 000 filas por vista en el
  peor caso de fin de temporada. Mitigación: índice por partido y ventana desde `starts_at`; si la
  medición en staging lo pide, materializar la tabla en el sync (§11).
- **Resultados una vez por día.** Los puntos llegan a la mañana siguiente. Mitigación: la UI lo dice en
  la tabla y en el historial («Sin resultado todavía»).
- **Navegación.** Otra sesión audita la UI del resto de la app en paralelo: el cambio de cabecera es
  mínimo y puede generar un conflicto de merge en `Layout.astro`, `Cabecera.astro` o `tribuna90.css`.
- **Datos personales.** Nombres y pronósticos visibles para el grupo: abreviados, sin email, y
  revelados solo después del inicio. Se actualiza la política de privacidad.
- **Abuso de códigos.** Límite por IP y por usuario en unirse; regenerar el código corta un link filtrado.

## 10. Fuera de alcance

Ranking global, premios o apuestas con dinero, chat, notificaciones push o email («te falta cargar»),
renombrar grupos, puntajes configurables, prode de varias competencias a la vez, y un acceso al prode
desde la ficha del partido.

## 11. Después de esta iteración

- Recordatorio en el calendario («cerrá tu prode») reutilizando la integración existente.
- Tabla materializada por grupo si las lecturas lo piden.
- Puntaje configurable por grupo (5/3/1, fases con multiplicador).
- Enlace «Pronosticá» en la ficha del partido y en Hoy.

## 12. Decisiones abiertas

Ninguna bloqueante. Las tomadas sin consulta (por correr sin supervisión) son D1–D17 de §3; se
revisan en el PR.

## 13. Notas de implementación (desvíos respecto del diseño original)

Implementado en la rama `feat/prode` el 20/11/2026, en la misma corrida que el diseño (§0).

**Datos y consultas**

- La primera versión de la tabla unía `prode_predictions` con `matches` entre paréntesis. El plan de SQLite
  materializaba los pronósticos de **todos los usuarios** de la competencia antes de cruzarlos con los
  miembros: crecía con la app, no con el grupo. Se reescribió para que cada miembro busque sus pronósticos
  por clave primaria (`p.match_id IN (SELECT … FROM matches WHERE league_id = ? AND date_time >= ?)`). El
  test de planes (`planes-de-consulta.test.ts`) ahora exige `SEARCH p USING INDEX … (user_id=?`; con la
  consulta anterior falla.
- `UPDATE … FROM matches` funciona en la D1 de Miniflare y el plan va por `idx_matches_date` y
  `prode_predictions_match_idx` (también fijado por test).
- `TERMINADO` usa `COALESCE(m.status, '')`: con `status` nulo, `NOT (…)` daba NULL y el partido no se anulaba.
- `prode_predictions` y las otras dos tablas también se declararon en `drizzle/schema.ts` (se actualizó el
  snapshot), aunque el acceso es con SQL directo.

**API**

- Un cuerpo con más de 40 pronósticos responde `400 demasiados_pronosticos` con `maximo`, no
  `cuerpo_invalido`: la UI parte el envío en lotes y el código distinto ayuda a diagnosticar.
- `runSync` recibe `puntuarPronosticos` como dependencia inyectable (como `syncLote`), para probar el fallo.
- El límite `prode_crear` (10 por hora) quedó cubierto por un test que recibe el 429.

**Interfaz** (decisiones tomadas al ver las capturas)

- Al cargar un lado del marcador, el otro arranca en 0: un pronóstico necesita los dos goles y así 2-0
  son dos toques. Borrar los dos lados borra el pronóstico.
- La barra «Guardar» queda fija abajo **solo con cambios sin guardar**; sin cambios es una fila más y no
  tapa el último partido.
- En escritorio (≥ 720 px) el cruce va en una línea («Local [goles] – [goles] Visitante»); en móvil, un
  equipo por fila con el marcador a la derecha.
- Los signos − y + son íconos de trazo: Anton no trae el signo menos y caía en otra fuente.
- El ícono de Prode en la cabecera móvil es un tanteador (1 | 0): la copa ya es el ícono de Ligas. Bajo
  381 px queda solo el ícono, con «Prode» como nombre accesible.
- Con cinco secciones la cabecera desbordaba entre 641 y 1000 px (lo detectó el reflow a 768 px de la
  auditoría UX): el saludo se oculta bajo 1000 px y en tablet el buscador queda como lupa, con el texto
  para lectores de pantalla. Es el único cambio visual fuera del prode, además de la sección nueva.
- Astro colapsaba el espacio entre dos expresiones seguidas («3pts»): esos textos se arman con template
  literals.
- A quien no administra, la lista de miembros le llega con claves por posición, no con ids de usuario.

**Tests y evidencia**

- Los datos E2E del prode viven en una competencia propia, activa y no destacada, con partidos a ±20 días:
  fuera de las ventanas de Hoy (−2 a +9) y Partidos (14 días), para no mover los tests existentes.
- `tests/e2e/prode-capturas.spec.ts` genera `docs/ux-evidence/prode/` (escritorio 1280 y móvil 375, escala
  1 como el resto de la evidencia); se saltea salvo con `PRODE_CAPTURAS=1`.
- En el entorno de esta corrida el Chromium preinstalado no coincide con `@playwright/test` 1.64.1 y no hay
  WebKit: los E2E y la auditoría UX se corrieron con una configuración local (no versionada) que apunta a ese
  Chromium, en los proyectos desktop y mobile. El proyecto `webkit-mobile` lo corre el CI.
- Resultado: typecheck sin errores; discovery OK; 1404 tests de Vitest con los umbrales de cobertura
  (`lib/prode` 98,5 % de líneas, `pages/api/prode` 100 %); build OK; 132 E2E y 144 casos de la auditoría UX
  aprobados (desktop y mobile), sin fallidos.

**Pendiente**

- Validación con personas (§2.5) y medición de lecturas D1 de la tabla en staging (§9).
