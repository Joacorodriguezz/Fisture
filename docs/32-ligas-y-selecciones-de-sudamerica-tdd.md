# TDD: Ligas y selecciones de Sudamérica

> Technical Design Document. Estado: **propuesto** (pendiente de revisión). Se implementa en dos entregas
> independientes, cada una con su rama desde `development` y su PR: **Fase A** (ligas,
> `feat/ligas-sudamerica`) y **Fase B** (selecciones, `feat/selecciones-sudamerica`).

## 1. Contexto y problema

Fisture sincroniza 43 competencias de ESPN (docs/09, docs/22). De Sudamérica solo tiene dos ligas
(Argentina y Brasil) y las copas CONMEBOL de clubes. Eso deja afuera a dos públicos naturales de la app:

1. **Hinchas de clubes de las otras 8 ligas de CONMEBOL.** Hoy Peñarol, Nacional, Colo-Colo, Atlético
   Nacional, LDU o Cerro Porteño existen en la base solo si juegan Libertadores o Sudamericana, y únicamente
   con esos partidos. Su campeonato local, que es la mayor parte de su calendario, no aparece.
2. **Quienes siguen a su selección.** No hay ninguna selección: Argentina–Uruguay (13/11/2026) no se puede
   agregar al calendario.

Relevamiento contra ESPN real (13/11/2026, mismo método que docs/22 D1: `soccer/{slug}/scoreboard` y
`soccer/all/teams/{id}/schedule` de cada equipo de cada liga):

| Liga | Slug | Equipos | Partidos 2026 | Otras competencias de sus equipos en ESPN |
| --- | --- | --- | --- | --- |
| Uruguay | `uru.1` | 16 | 289 | ninguna |
| Colombia | `col.1` | 20 | 394 | `col.copa` (Copa Colombia), `col.superliga` (Superliga) |
| Chile | `chi.1` | 16 | 240 | `chi.copa_chi` (Copa Chile), `chi.super_cup` (Supercopa) |
| Ecuador | `ecu.1` | 16 | 312 | `ecu.supercopa` (Supercopa) |
| Paraguay | `par.1` | 12 | 264 | `par.1.supercopa` (Supercopa) |
| Perú | `per.1` | 18 | 306 | ninguna |
| Bolivia | `bol.1` | 16 | 224 | `bol.copa` (Copa Bolivia), `bol.ply.rel` (promoción y descenso) |
| Venezuela | `ven.1` | 12 | 231 | ninguna |

(`club.friendly` y `col.2` también aparecen, pero quedan afuera por el mismo criterio que docs/22.)

Selecciones (ESPN usa el mismo espacio de IDs de equipo para clubes y selecciones): Argentina `202`,
Bolivia `204`, Brasil `205`, Chile `207`, Colombia `208`, Ecuador `209`, Paraguay `210`, Perú `211`,
Uruguay `212`, Venezuela `213`. Sus competencias:

| Slug | Qué es | Partidos 2026 | Partidos 2027 |
| --- | --- | --- | --- |
| `fifa.worldq.conmebol` | Eliminatorias sudamericanas | 0 | 0 |
| `conmebol.america` | Copa América | 0 | 0 |
| `fifa.world` | Mundial | 104 (ya jugado) | 0 |
| `fifa.friendly` | Amistosos internacionales | 408 (198 selecciones) | 1 |

El problema de fondo para las selecciones: **hoy no hay ninguna competencia oficial de selecciones vigente
en ESPN**. El Mundial 2026 terminó y ni las Eliminatorias 2030 ni la próxima Copa América están publicadas.
Lo único que juegan son amistosos, y `fifa.friendly` mezcla 198 selecciones. Con el modelo de docs/22:

- como **copa destacada**, `fifa.friendly` listaría las 198 selecciones en `/ligas` y en la búsqueda;
- como **copa no destacada** (docs/22 D3), no guardaría nada: ninguna selección es un "equipo conocido",
  porque no participa de ninguna competencia destacada;
- `fifa.worldq.conmebol` como copa destacada tampoco alcanza: sus participantes se calculan con los
  partidos de la temporada en curso (`espn.ts`, `participantIds`) y hoy no hay ninguno.

Datos clave que salieron del relevamiento:

- `soccer/fifa.worldq.conmebol/teams` devuelve **exactamente las 10 selecciones de CONMEBOL**, con logo,
  aunque no haya partidos programados.
- Con `?lang=es` ESPN devuelve los nombres de las selecciones en español ("Brasil", "Arabia Saudita",
  "Baréin"), con algún error ("Bolívia"). Los slugs de temporada no cambian con el idioma.
- Varias ligas nuevas usan slugs de etapa que `espn.ts` no traduce ni numera (§4.2).

## 2. Objetivos y no objetivos

**Objetivos**

1. Fase A: sincronizar las 8 ligas restantes de CONMEBOL como ligas destacadas, con sus copas nacionales
   como competencias no destacadas, y con las rondas en español y la "Fecha N" correcta.
2. Fase B: que las 10 selecciones de CONMEBOL se puedan buscar, seguir y agregar al calendario, con todos
   sus partidos: amistosos, Eliminatorias, Copa América y Mundial, cuando ESPN los publique.
3. Que las selecciones aparezcan con su nombre en español.
4. Que el sync diario siga entrando en Workers Free (50 subrequests por invocación) y que el aumento de
   lecturas de D1 quede medido.

**No objetivos**

- Selecciones de otras confederaciones como equipos seguibles (sí aparecen como rival de una sudamericana).
- Fútbol femenino, juveniles (Sub-20, Sub-17) y Juegos Olímpicos.
- Ligas de ascenso (`col.2`) y amistosos de clubes (`club.friendly`), por el criterio de docs/22.
- México (`mex.1`) y la MLS (`usa.1`): están en ESPN, pero quedan para otra iteración.
- Una sección o filtro "Selecciones" propio en la UI: la competencia de selecciones se lista junto con
  las demás, como una competencia sudamericana más.
- Cambiar de proveedor de datos.

## 3. Decisiones

**D1. Dos entregas.** La Fase A es solo configuración y traducción de etapas, sin conceptos nuevos. La
Fase B toca el sync. Separarlas permite desplegar las ligas sin esperar al diseño más riesgoso, y si la B
se complica no frena a la A. Descartado: un solo PR, que mezclaría dos propósitos (CLAUDE.md: "un PR = un
propósito").

**D2. Ligas con `liga(...)` y copas con `copa(...)`, sin código nuevo de sync.** Las 8 ligas entran como
destacadas y las 8 copas como no destacadas, respetando el orden de `LEAGUES_CONFIG` (ligas → copas
destacadas → resto). Los clubes que ya entraron por Libertadores o Sudamericana (sin país) adoptan su liga
de origen solos, por docs/22 D5. Descartado: dejar las supercopas afuera para ahorrar lotes. Son baratas
(uno o dos partidos al año) y completan el fixture del equipo, que es el objetivo de docs/22.

**D3. Las selecciones entran por una competencia destacada con participantes fijos: las Eliminatorias.**
Se agrega `fifa.worldq.conmebol` ("Eliminatorias Sudamericanas", país "Sudamérica") como destacada, pero
sus participantes no salen de la temporada en curso: salen de `soccer/fifa.worldq.conmebol/teams`, que
siempre devuelve las 10 selecciones. Es la definición real de la competencia: las 10 juegan todas las
ediciones. Con eso las 10 pasan a ser "equipos conocidos", y los amistosos, la Copa América y el Mundial
entran como **copas no destacadas** por el mecanismo existente (docs/22 D3): guardan solo los partidos de
una selección sudamericana, con su rival.

Alternativas descartadas:

- *`fifa.friendly` destacada*: lista 198 selecciones.
- *Competencia sintética "Selecciones de Sudamérica" (sin slug de ESPN)*: rompe la convención
  `externalId = slug` que usan `getFixture`, `sync:check` y el endpoint `{"leagueId": ...}`. Además, en cada
  partido se mostraría el nombre de una competencia que no existe.
- *IDs de selección fijos en el código*: duplica un dato que ESPN ya entrega y no trae nombre ni logo.

**D4. Nuevo campo `participantes` en `LeagueConfig`: `"temporada"` (por defecto) o `"plantel-fijo"`.** Con
`"plantel-fijo"`, `getFixture` pide además `soccer/{slug}/teams` y usa esos equipos como `participantIds`
y como filas de equipo. Es 1 pedido más a ESPN para esa competencia. Así la regla vive en la configuración,
como `destacada`, y no en un `if (slug === ...)` dentro del sync. Descartado: deducir los participantes de
temporadas anteriores (`dates=2025`), porque cuesta pedidos extra y falla si una selección no jugó la
última edición.

**D5. Nombres en español solo para las competencias de selecciones (`lang=es`).** Las cuatro competencias
de selecciones se piden con `lang=es`. Un mapa chico de correcciones en `espn.ts` (`NOMBRES_SELECCION`,
por ID de ESPN; hoy solo `204 → "Bolivia"`) arregla los errores de ESPN. Las competencias de clubes **no**
cambian de idioma: reescribiría el nombre de cientos de equipos ya guardados, y cada cambio de nombre es
una escritura en D1. Para que el nombre no alterne entre sync y sync, una selección solo puede aparecer en
competencias pedidas con el mismo idioma. Se verifica con un test sobre `LEAGUES_CONFIG` (§5). Descartado:
un mapa de traducción completo, porque los rivales de los amistosos son de cualquier país y son demasiados.

**D6. Las selecciones son "liga de origen" de sí mismas.** Una competencia con `participantes:
"plantel-fijo"` se trata como liga para la liga de origen y el país (`syncEquipos`): `league_id` = las
Eliminatorias, `country` = "Sudamérica". Sin esto, las selecciones quedan sin país y la página del equipo
pierde el rótulo. Se generaliza la condición `config.tipo === "liga"` a una función
`defineOrigen(config)`. Descartado: un `tipo: "seleccion"` nuevo, que obligaría a revisar cada uso de
`tipo` (numeración de fechas, `esLigaLocal`, páginas) por un caso que se resuelve con un flag.

**D7. `empty_league` ignora a las destacadas de plantel fijo.** Las Eliminatorias van a estar sin partidos
hasta que ESPN publique el calendario 2030. Es esperable, y avisar todo el año sería ruido, igual que
docs/22 D6.

**D8. Etapas nuevas en `espn.ts`.** Se agregan a `ETAPAS` y `ETAPAS_CON_FECHAS` los slugs relevados
(§4.2), y `partirEtapa` normaliza el sufijo de año (`torneo-apertura-2026` → `torneo-apertura`), así
Paraguay no necesita una entrada por año. Descartado: dejarlas sin traducir. La ronda se mostraría vacía o
sin "Fecha N", como pasa hoy con Paraguay en `sync:check`.

## 4. Diseño

### 4.1 Configuración (`data-providers/types.ts`)

Fase A, ligas (después de `bra.1`):

```ts
liga({ externalId: "uru.1", name: "Liga AUF Uruguaya", country: "Uruguay", region: "sudamerica" }),
liga({ externalId: "col.1", name: "Liga BetPlay", country: "Colombia", region: "sudamerica" }),
liga({ externalId: "chi.1", name: "Primera División de Chile", country: "Chile", region: "sudamerica" }),
liga({ externalId: "ecu.1", name: "LigaPro Ecuador", country: "Ecuador", region: "sudamerica" }),
liga({ externalId: "par.1", name: "Primera División de Paraguay", country: "Paraguay", region: "sudamerica" }),
liga({ externalId: "per.1", name: "Liga 1 de Perú", country: "Perú", region: "sudamerica" }),
liga({ externalId: "bol.1", name: "División Profesional de Bolivia", country: "Bolivia", region: "sudamerica" }),
liga({ externalId: "ven.1", name: "Liga FUTVE", country: "Venezuela", region: "sudamerica" }),
```

Fase A, copas no destacadas (al final, por país):

| País | Entradas |
| --- | --- |
| Colombia | `col.copa` Copa Colombia, `col.superliga` Superliga de Colombia |
| Chile | `chi.copa_chi` Copa Chile, `chi.super_cup` Supercopa de Chile |
| Ecuador | `ecu.supercopa` Supercopa de Ecuador |
| Paraguay | `par.1.supercopa` Supercopa de Paraguay |
| Bolivia | `bol.copa` Copa Bolivia, `bol.ply.rel` Promoción de Bolivia |

Fase B:

```ts
// Después de las copas destacadas: hace "conocidas" a las 10 selecciones
copaDestacada({ externalId: "fifa.worldq.conmebol", name: "Eliminatorias Sudamericanas", country: "Sudamérica",
  region: "sudamerica", participantes: "plantel-fijo", idioma: "es" }),
// Al final, con el resto de las no destacadas
copa({ externalId: "fifa.friendly", name: "Amistosos internacionales", country: "Mundial", region: "mundial", idioma: "es" }),
copa({ externalId: "conmebol.america", name: "Copa América", country: "Sudamérica", region: "sudamerica", idioma: "es" }),
copa({ externalId: "fifa.world", name: "Mundial", country: "Mundial", region: "mundial", idioma: "es" }),
```

Los nombres exactos de las ligas se confirman en la revisión. Los de arriba son los comerciales vigentes.

Totales: 43 → 59 competencias (12 lotes) con la Fase A, y 63 (13 lotes) con la B.

### 4.2 Etapas (`data-providers/espn.ts`)

| Slug de ESPN | Liga | Texto | ¿Numera fechas? |
| --- | --- | --- | --- |
| `torneo-intermedio` | Uruguay | Torneo Intermedio | sí |
| `intermedio-final` | Uruguay | Torneo Intermedio · Final | no |
| `apertura`, `clausura` | Colombia, Perú, Venezuela | Apertura / Clausura | sí |
| `apertura-quadrangular`, `clausura-quadrangular` | Venezuela | Apertura / Clausura · Cuadrangular | sí |
| `apertura-final` | Venezuela | Apertura · Final | no |
| `first-stage` (en liga) | Ecuador | Primera fase | sí, solo en ligas locales |
| `final-stage` | Ecuador | Fase final | sí |
| `torneo-apertura-2026`, `torneo-clausura-2026` | Paraguay | Apertura / Clausura (sufijo de año normalizado) | sí |
| `group-stage1a`, `stage-1b` | Copa Colombia | Fase de grupos / Fase 1B | sí / no |
| `2026-primera-division-de-chile` | Chile, Bolivia | Fecha N (ya funciona) | sí |

`first-stage` ya está en `ETAPAS` para las copas, donde no numera. La numeración se condiciona a
`esLigaLocal(slug)`, como ya pasa con `etapaEsLiga`, para no cambiar las rondas de copas que hoy están
bien.

### 4.3 Sync (`data-providers/espn.ts`, `sync.ts`), solo Fase B

| Pieza | Cambio |
| --- | --- |
| `LeagueConfig` | `participantes?: "temporada" \| "plantel-fijo"` (por defecto `"temporada"`) e `idioma?: "es"` |
| `espn.ts` `pedirTemporada` | agrega `&lang=es` si la competencia lo declara |
| `espn.ts` `getFixture` | con `"plantel-fijo"` pide `/{slug}/teams` (con reintentos, como el scoreboard) y suma esos equipos a `teams` y los usa como `participantIds` |
| `espn.ts` | `NOMBRES_SELECCION` aplicado a todo equipo de una competencia con `idioma` |
| `sync.ts` `syncEquipos` | `defineOrigen(config)` = `tipo === "liga" \|\| participantes === "plantel-fijo"` en lugar de `tipo === "liga"` (alta y adopción de liga) |
| `consistency.ts` | `empty_league` excluye a las competencias de plantel fijo (D7). Se persiste en `leagues` sin migración: la lista de slugs de plantel fijo sale de `LEAGUES_CONFIG` y entra al SQL como parámetro |

Que `getFixture` pueda recibir la configuración y no solo el slug implica un cambio de firma interno:
`getFixture(slug, { participantes, idioma })`, que se pasa desde `syncLeague`. `DataProvider` lo admite en
`FixtureOptions`.

### 4.4 Presupuesto por invocación

docs/22 D4 cuenta ~42 subrequests por lote de 5 en el caso normal y ~52 en el peor, con un reintento. Las
Eliminatorias suman 1 pedido (`/teams`). En el peor caso, el lote que las contenga quedaría en ~53. Para
no depender de la suerte del orden, un test fija que **ningún lote tenga más de una competencia de plantel
fijo**, y el cálculo de D4 se actualiza en docs/22 y docs/24.

### 4.5 Volumen y lecturas de D1

- Partidos: ~2.260 de las ligas nuevas por año, más unos 100 de copas nacionales y ~40 de selecciones.
  Hoy son ~5.000 más los de las ligas existentes, así que la tabla `matches` crece un ~30 %.
- Equipos: ~126 clubes (parte ya existe por las copas CONMEBOL), 10 selecciones y sus rivales de amistosos.
- Lecturas: con docs/30 los chequeos de consistencia corren una vez por barrido y las búsquedas por
  competencia van por índice (`0014`). El costo por competencia es casi constante, así que se espera un
  aumento proporcional a los lotes (+44 %) en las lecturas del sync, no en las de las páginas. Staging
  comparte la cuota (memoria del proyecto y docs/30 §1): se mide **D1 → Metrics** el día del primer barrido
  en staging y el del primer barrido en producción, y se completa docs/24 §2.

## 5. Estrategia de tests (rojo, verde, refactor)

Cada punto se escribe primero en rojo.

**Fase A**

- `tests/unit/competencias.test.ts`:
  - las 10 ligas sudamericanas son destacadas;
  - las 8 copas nuevas no lo son;
  - el orden ligas → destacadas → resto se mantiene;
  - no hay slugs duplicados;
  - todos los lotes tienen como mucho `COMPETENCIAS_POR_LOTE`.
- `tests/unit/espn.test.ts`, una tabla con cada slug de §4.2 y su texto esperado:
  - `partirEtapa("torneo-apertura-2026")` normaliza el año;
  - `first-stage` numera en `ecu.1` y no en `conmebol.libertadores` (regresión);
  - `apertura-quadrangular` lleva "Fecha N".
- `tests/integration/data-sync.test.ts`: un club que entró por la Libertadores (sin país) adopta `uru.1`
  al sincronizarla (D5 de docs/22 aplicado a las ligas nuevas). Fixture de ESPN grabado, sin red.

**Fase B**

- `espn.test.ts`:
  - con `"plantel-fijo"` y un scoreboard vacío, `getFixture` devuelve las 10 selecciones como
    participantes;
  - `/teams` con 500 reintenta y después falla la competencia, no el lote;
  - `lang=es` se agrega solo cuando la configuración lo pide;
  - `NOMBRES_SELECCION` corrige "Bolívia".
- `data-sync.test.ts`:
  - después de sincronizar las Eliminatorias sin partidos, un amistoso Argentina–Costa Rica se guarda
    con Costa Rica como rival, y un amistoso Japón–Corea no se guarda;
  - Costa Rica no aparece en la búsqueda (no participa de ninguna destacada);
  - la selección queda con `league_id` = Eliminatorias y `country` = "Sudamérica";
  - un segundo sync no escribe nada, ni siquiera nombres.
- `competencias.test.ts`:
  - toda competencia en la que puede aparecer una selección declara `idioma: "es"` (D5);
  - ningún lote tiene más de una competencia de plantel fijo (§4.4).
- `consistency.test.ts`: unas Eliminatorias sin partidos no generan `empty_league`, y una liga destacada
  vacía sí.
- E2E (Playwright): buscar "Uruguay" ofrece la selección y la liga; la página de la selección muestra
  "Juega Eliminatorias Sudamericanas · Amistosos internacionales" y sus próximos partidos.
- Manual: `SYNC_TWICE=1 npm run sync:check` contra ESPN real con las competencias nuevas, y después
  `sync:check` completo. Se registra la duración y que la segunda pasada no escribe nada.

## 6. Plan de implementación

**Fase A** (`feat/ligas-sudamerica`)

1. Tests de configuración en rojo → 16 entradas en `LEAGUES_CONFIG` → verde.
2. Tests de etapas en rojo → `ETAPAS`, `ETAPAS_CON_FECHAS` y la normalización de año en `partirEtapa` → verde.
3. Test de adopción de liga con las ligas nuevas.
4. `SYNC_TWICE=1 npm run sync:check -- uru.1 col.1 chi.1 ecu.1 par.1 per.1 bol.1 ven.1` y revisión de las
   rondas generadas.
5. Actualizar docs/09 (tabla de competencias), docs/22 D4 (cantidad de lotes) y CLAUDE.md
   (Observabilidad: lista de destacadas).

**Fase B** (`feat/selecciones-sudamerica`, después de mergear la A)

1. Tipos (`participantes`, `idioma`) y tests de configuración.
2. `getFixture` con plantel fijo, `lang` y correcciones de nombre (tests unitarios).
3. `defineOrigen` en `syncEquipos` y tests de integración de amistosos y rivales.
4. `empty_league` (D7).
5. E2E de búsqueda y página de selección.
6. `sync:check` real; actualizar docs/09, docs/22 y docs/24.

## 7. Despliegue y rollback

- **Sin migraciones de D1** en ninguna de las dos fases: todo entra en las columnas existentes
  (`is_featured` es de la `0009`).
- **Sin variables de entorno nuevas.**
- Staging: el push a `development` resincroniza en staging (memoria del proyecto: comparte la cuota de D1
  con producción). Conviene mergear cada fase lejos del sync diario de producción y no hacer pushes
  seguidos a `development` ese día.
- Producción: después del release, `sync-cron.yml` carga las competencias nuevas en el siguiente barrido
  (12 o 13 lotes). Se puede adelantar con *Run workflow*. El primer barrido escribe del orden de 3.000 a
  4.000 filas nuevas, por debajo del tope de 100.000 escrituras por día.
- Rollback: volver al deployment anterior en Pages. Las competencias que salen de `LEAGUES_CONFIG` quedan
  `is_active = 0` en el siguiente barrido completo (`desactivarLigasObsoletas`). Sin esperar al barrido se
  ocultan con `UPDATE leagues SET is_active = 0 WHERE external_id IN (...)`. Los equipos y partidos quedan
  en la base, sin borrar, como hoy con cualquier competencia retirada. Los usuarios que siguen a un equipo
  nuevo lo siguen teniendo, pero sin partidos nuevos.

## 8. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| ESPN cambia un slug o deja de cubrir una liga chica (Venezuela, Bolivia) | Una competencia que falla no frena a las demás (run `partial`). Se ve en `/api/admin/status` |
| `/fifa.worldq.conmebol/teams` cambia de contenido o deja de responder | Si falla, falla solo esa competencia y las selecciones conservan su `league_teams` del sync anterior. Test de contrato con la respuesta grabada |
| El nombre de una selección alterna entre idiomas y escribe en cada sync | Test D5 sobre la configuración y test de "segundo sync sin escrituras" |
| Un lote pasa de 50 subrequests | Test de un plantel fijo por lote (§4.4); el workflow sigue con el siguiente lote y termina en error |
| Lecturas de D1 (+44 % de lotes) en un mes en que ya se agotó la cuota (6/11) | Medir en staging antes del release; umbral de docs/24 §3 (2,5 M/día) |
| Nombre de equipo repetido entre selección y club ("Liverpool" ya pasa) o entre selección y país de liga | Se distinguen por ID. La búsqueda muestra la competencia de origen de cada resultado |
| ESPN carga las Eliminatorias 2030 con otro slug | Revisar `soccer/all/teams/202/schedule` cuando FIFA publique el calendario, y ajustar la configuración |
| Los clubes de las ligas nuevas ya existen con el nombre de la copa CONMEBOL | Mismo ID global, así que es una sola fila. Adopción de liga por docs/22 D5 |

**Decisiones de la revisión (2026-11-13)**

- Nombres visibles de las ligas: **comerciales** ("Liga BetPlay", "Liga FUTVE"...), como en §4.1.
- Flujo de selecciones confirmado: se piden los amistosos (`fifa.friendly`), se filtran los partidos en los
  que juega una selección sudamericana y además se usan las Eliminatorias. Lo que define "sudamericana" es
  el plantel de las Eliminatorias (D3, D4), no una lista escrita a mano.

**Decisiones abiertas**

- Si el Mundial (`fifa.world`) entra ya o recién cuando se acerque 2030: hoy solo traería partidos jugados
  de 2026.

## 9. Notas de implementación (desvíos respecto del diseño original)

_Vacío hasta la implementación._
