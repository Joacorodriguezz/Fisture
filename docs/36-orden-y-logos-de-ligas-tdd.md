# TDD: Orden y logos de las competencias

> Technical Design Document. Estado: **pendiente de aprobación**.

## 1. Contexto y problema

1. Las competencias se listan por orden alfabético (`orderBy(asc(leagues.name))` en `/ligas`,
   `/equipos/buscar` y `queries.ts`). Para un hincha argentino eso pone la Bundesliga antes que la
   Liga Profesional. El producto necesita una prioridad editorial.
2. Las competencias no tienen logo: `leagues.logo` existe en el schema pero el sync nunca lo escribe, así
   que las tarjetas muestran solo texto.

Relevamiento contra ESPN real (17/11/2026): `site/v2/sports/soccer/{slug}/scoreboard` trae
`leagues[0].logos` con dos variantes por competencia, la clara
(`https://a.espncdn.com/i/leaguelogos/soccer/500/{n}.png`, rel `default`) y la oscura (`.../500-dark/{n}.png`,
rel `dark`). Verificado en `arg.1`, `eng.1`, `uefa.champions`, `conmebol.libertadores` y
`fifa.worldq.conmebol`. **No hace falta cargar los logos a mano.**

## 2. Objetivos y no objetivos

Objetivos:
- Un orden fijo y explícito de las competencias destacadas, igual en todas las pantallas que las listan.
- Guardar el logo de cada competencia desde ESPN en `leagues.logo` y mostrarlo en las tarjetas.

No objetivos: orden personalizable por usuario; subir logos propios; logos de competencias no destacadas
(no se listan); cambiar qué competencias son destacadas.

## 3. Decisiones

**D1. Orden.** Nuevo campo `prioridad` (número, menor = primero) en `LeagueConfig`
(`data-providers/types.ts`), junto al resto de la configuración, y un helper puro
`ordenarCompetencias(filas)` que ordena por prioridad de `externalId` y desempata por nombre. Las
competencias con `externalId` desconocido van al final.

Orden pedido (los grupos van de arriba abajo; dentro de un grupo, el orden de la lista):

| # | Grupo | Competencias |
| --- | --- | --- |
| 1 | Argentina | Liga Profesional (`arg.1`) |
| 2 | Copas sudamericanas | Libertadores, Sudamericana |
| 3 | Premier y Champions | Premier League, UEFA Champions League |
| 4 | Resto de Europa | La Liga, Serie A, Bundesliga, Ligue 1 |
| 5 | UEFA | Europa League, Conference League |
| 6 | Resto de Sudamérica | Brasileirão, Liga Uruguaya, Colombia, Chile, Ecuador, Paraguay, Perú, Bolivia, Venezuela |
| 7 | Selecciones | Eliminatorias Sudamericanas |

Supuestos a confirmar: Premier antes que Champions; Europa League antes que Conference; el resto de
Sudamérica va en el orden de arriba (Brasil, Uruguay, y luego las demás en el orden en que ya están en
`LEAGUES_CONFIG`).

*Alternativa descartada:* columna `sort_order` en D1. Obliga a migración y a esperar un sync para que
tenga valores; el orden vive de todos modos en la config, y son 6 puntos de consulta con pocas filas
(≤ 20 competencias destacadas), así que ordenar en JS no cuesta nada. Si más adelante hace falta
ordenar en SQL, se agrega la columna sin cambiar la API del helper.

**D2. Logos.** `ProviderLeague` gana `logo?: string` y el proveedor ESPN lo lee de
`scoreboard.leagues[0].logos` (variante `default`). `syncLeague` lo escribe en `leagues.logo` (insert y
`onConflictDoUpdate`). Es un request más por competencia, pero **el scoreboard ya se pide** para el
fixture; se reutiliza esa respuesta, sin subrequests nuevos (importa por el tope de 50 de Workers Free,
docs/22). Si ESPN no trae logo, se conserva el que ya había (no se pisa con `null`).

*Alternativa descartada:* cargarlos a mano en `public/`. Funciona, pero hay que mantenerlos y los
`externalId` nuevos quedarían sin logo.

**D3. Variante oscura.** Se guarda solo la `default`. La app no tiene hoy tema oscuro en las tarjetas de
liga; si aparece, el logo oscuro se deriva reemplazando `/500/` por `/500-dark/` en la URL, sin columna
nueva.

**D4. Mostrar.** Reutilizar el componente `Escudo` (ya resuelve imagen faltante con sigla) en `/ligas`,
filtros y búsqueda. Mientras `logo` sea `null` (antes del primer sync) se ve el fallback actual.

## 4. Estrategia de tests (test primero)

Rojo, verde, refactor:
1. `ordenarCompetencias`: respeta los 7 grupos; desconocidas al final; estable y con desempate por nombre;
   toda competencia destacada de `LEAGUES_CONFIG` tiene prioridad (test de guardia: agregar una liga sin
   prioridad rompe el test).
2. Proveedor ESPN: extrae el logo `default` de un scoreboard de ejemplo; tolera `logos` ausente o vacío.
3. `syncLeague` (D1 efímera): escribe el logo en el insert, lo actualiza si cambia y no lo pisa con `null`.
4. Páginas: `/ligas` y `/equipos/buscar` devuelven las competencias en el orden definido (E2E o prueba de
   render con datos sembrados).
5. `npm run sync:check` contra ESPN real: toda destacada obtiene logo.

## 5. Plan de implementación

1. Tests del helper de orden (rojo) → `prioridad` en `LEAGUES_CONFIG` + helper (verde).
2. Aplicar el helper en `/ligas`, `/equipos/buscar` y `queries.ts` (consulta de línea 278).
3. Tests del logo en el proveedor y el sync (rojo) → implementación (verde).
4. Mostrar el logo en las tarjetas y filtros.
5. `npm run check`, revisión y PR a `development`.

Dos PRs si se prefiere entregar rápido: orden (pasos 1-2) y logos (3-4). Son independientes.

## 6. Despliegue y rollback

Sin migración D1 ni variables nuevas. El orden se ve en el deploy; los logos aparecen tras el siguiente
sync diario (o un `POST /api/admin/sync` manual). Rollback: revertir el PR; `leagues.logo` queda con las
URLs, que son inofensivas.

## 7. Riesgos

- ESPN cambia el formato de `leagues[].logos`: el logo queda `null` y se ve el fallback; no rompe el sync.
- Hotlink a `a.espncdn.com`: depende de que ESPN lo mantenga (los escudos de equipos ya se sirven igual).
  Mitigación posible fuera de alcance: copiarlos a R2.
- El orden es editorial y vive en código: cambiarlo requiere un deploy.

## 8. Notas de implementación

Estado: **implementado**. Desvíos respecto del diseño:

- **Logos propios en vez de solo ESPN (D2/D3).** Se descargaron de Paladar Negro (Escudoteca PN) los logos de
  15 ligas y 5 copas, y para Bolivia se usó el SVG de football-logos.cc. Se guardan achicados (256 px,
  márgenes transparentes recortados) en `public/logos/competencias/{externalId}.png|svg`. El mapa vive en
  `lib/logos-competencias.ts` (`LOGOS_PROPIOS`, `logoDeCompetencia`): el logo propio gana sobre el de ESPN
  y las competencias sin archivo (Eliminatorias) siguen con el de ESPN. La escudoteca.com original se
  descartó: solo tiene escudos de clubes.
- **El logo se escribe con un UPDATE posterior al insert de la liga**, no dentro del insert, porque se
  conoce recién tras pedir el fixture. Solo si cambió y nunca con `null`.
- **Chile** queda con el logo de la liga con el sponsor (Mercado Libre), por decisión de producto.
- **UI:** en `/ligas` el logo va al lado del nombre (44 px) y se quitó la etiqueta de país/región; en
  `/ligas/[id]` el logo del encabezado es de 48 px.
- **Pendiente:** logos en los filtros y la búsqueda (D4); `urlEscudo` no reduce los de `leaguelogos` de ESPN
  (solo se usan en las Eliminatorias); E2E y `sync:check` no corrieron en este entorno (`axe-core` bloqueado
  por el registro). El orden se aplica con `ordenarCompetencias` (`lib/competencias.ts`) y `prioridad` en
  `LEAGUES_CONFIG`.
