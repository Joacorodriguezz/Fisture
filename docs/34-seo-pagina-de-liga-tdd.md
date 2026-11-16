# 34 · SEO y GEO de la página de liga (TDD)

Estado: **aprobado el 15/11/2026; pasos 1 y 2 implementados**. Continúa `docs/33`: lleva a la página de liga
lo que los pasos 1 y 2 de ese plan hicieron en la de equipo y la de partido.

## 1. Contexto y problema

`docs/33` reforzó las plantillas de equipo y de partido, y dejó la de liga (`src/pages/ligas/[id].astro`)
como estaba. Hoy esa página tiene:

| Elemento | Equipo (después de docs/33) | Liga (hoy) |
|---|---|---|
| Título y `<h1>` | "Partidos y fixture de X" / "Fixture y partidos de X" | "Fixture de X" en los dos |
| Respuesta directa arriba | Sí (D2) | No |
| Últimos resultados | Hasta 5, con marcador | No |
| Hora en otros países | Renglón del próximo partido | Solo "Hora de Argentina (UTC−3)" |
| `SportsEvent` en JSON-LD | Hasta 10 próximos | No (solo `SportsOrganization` y migas) |
| Fecha o ronda del partido | — | El dato existe (`matches.round`) y no se muestra |

Datos de Search Console (25/10 al 10/11/2026, export del 13/11): la página de la Champions League es la
URL con mejor rendimiento del sitio fuera de la home (4 impresiones, 3 clics, posición 2,75) y `/ligas`
tuvo 13 impresiones en posición 4,69. Son pocas impresiones, pero en posiciones altas: a diferencia de las
páginas de equipo (posición media 53), las de liga ya compiten arriba y tienen poco contenido propio.

Fuera de temporada, o entre fechas de una copa, la sección de próximos partidos queda con "No hay partidos
programados" y la página solo ofrece la lista de equipos.

## 2. Objetivos y no objetivos

**Objetivos**

- Que la página de liga responda "cuándo se juega la próxima fecha de X" y "cómo salieron los últimos
  partidos de X" con datos reales, sin depender de JavaScript.
  [Contenido útil](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- Que una liga sin partidos próximos no quede vacía: muestra los últimos resultados.
- Mismos criterios de texto, hora y JSON-LD que en equipo y partido (una sola forma de decir cada cosa).

**No objetivos**

- Tabla de posiciones, goleadores o temporada completa: no hay datos de tabla y `docs/33` ya los descartó.
- Una página por fecha o por ronda (`/ligas/x/fecha-12`): páginas generadas en masa con poco contenido
  propio. [Políticas de spam](https://developers.google.com/search/docs/essentials/spam-policies)
- Cambiar el sitemap, las URLs o qué ligas se listan (`is_featured`, docs/22).
- Marcado `FAQPage` (retirado por Google en mayo de 2026) y cambios en `llms.txt` más allá del paso 2.
- Prometer posiciones: los datos actuales son de pocas impresiones.

## 3. Decisiones

| # | Decisión | Por qué | Alternativa descartada |
|---|---|---|---|
| L1 | **Título** `Fixture y partidos de {liga} - FISTURE`; **`<h1>`** `Fixture y partidos de {liga}`. | Las dos formas en que se busca, sin repetirlas, igual que en equipo (docs/33 D1). [Title links](https://developers.google.com/search/docs/appearance/title-link) | Dejar "Fixture de X": no cubre "partidos de la Champions". |
| L2 | **Respuesta directa arriba**, una oración: "El próximo partido de {liga} es {local} vs {visitante}, el sábado 21 de noviembre a las 15:00 (hora de Argentina)" más la ronda si existe ("por la Fecha 16"). Sin próximos en 30 días: "{liga} no tiene partidos programados en los próximos 30 días" y, si hay, el último resultado. | Responde la consulta sin otra búsqueda (heurística editorial, misma que docs/33 D2). [Contenido útil](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) | Párrafo descriptivo de la competencia: texto genérico que no sale de datos propios. |
| L3 | **Últimos resultados de la liga**: hasta 10 partidos terminados, con marcador si existe, enlazados a su página de partido. La sección solo aparece si hay resultados. | El dato ya está en D1 (`home_score`, `away_score`) y la liga fuera de fecha deja de quedar vacía. | Temporada completa: muchas más filas por visita sin evidencia de que haga falta. |
| L4 | **Hora por país del próximo partido**, un renglón debajo de la respuesta directa, con `horaPorPais` (docs/33 D4). La lista de próximos sigue en hora de Argentina, con el aviso actual. | El texto llega en el HTML del servidor; 6 de 11 clics del sitio vinieron de otros países. [JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) | Hora por país en cada uno de los 20 renglones: ruido visual en el celular. |
| L5 | **Ronda en la lista de próximos** cuando `matches.round` existe ("Fecha 16", "Octavos de final"). | Dato real que ya se guarda y distingue un partido de otro. | Agrupar la lista por ronda: en copas la ronda falta o se repite entre días. |
| L6 | **Próximos partidos como `SportsEvent`** en el JSON-LD (hasta 10, solo `scheduled`), con `jsonLdPartido`. | Describe los eventos a los buscadores; no garantiza resultado enriquecido ni mejora el ranking. [Datos estructurados](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data) | Dejarlo solo en equipo y partido. |
| L7 | **Textos en un módulo puro nuevo, `src/lib/seo-liga.ts`**, y el generador de eventos se comparte: `jsonLdPartidosDeEquipo` pasa a una función común que usan equipo y liga. | Mismo patrón que `seo-equipo.ts` y `seo-partido.ts`: se testea sin D1 ni Astro. | Armar los textos en la plantilla `.astro`: no se pueden testear en unidad. |
| L8 | **La página de liga no lleva `noindex`** aunque no tenga partidos. | Siempre conserva la lista de equipos con enlaces; las ligas listadas son pocas y fijas. [Robots meta](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) | Aplicar la regla D8 de equipos: sacaría del índice una liga en receso. |

## 4. Estrategia de tests (rojo, verde, refactor)

- **Unitarios (`tests/unit/seo`, módulo `seo-liga.ts`)**: título y `<h1>`; descripción; respuesta directa
  con próximo partido (con y sin ronda), sin próximos pero con último resultado (victoria local, victoria
  visitante, empate, sin marcador) y sin ningún partido; eventos del JSON-LD con tope de 10 y solo
  `scheduled`. Los tests existentes del JSON-LD de equipo siguen pasando tras el refactor de L7.
- **Integración con D1 efímera (`tests/integration/seo/pagina-liga.test.ts`)**: `getLeagueRecentMatches`
  (orden descendente, tope, solo `finished` con fecha pasada, marcador nulo, no trae otra liga).
- **Planes de consulta (`planes-de-consulta.test.ts`)**: la consulta nueva busca por `league_id` con
  `idx_matches_league_source` y no hace `SCAN` de `matches`.
- **E2E sin JavaScript (`seo-head.spec.ts`)**: la página de liga contiene la respuesta directa, la ronda,
  el renglón de hora por país, los resultados con marcador y los `SportsEvent`; una liga sin próximos
  muestra el texto alternativo y los resultados; no lleva `noindex` ni `nosnippet`.
- Cada paso corre `npm run check` y `npm run test:ux` antes del PR (el paso 1 de docs/33 falló en CI por
  no correr la segunda).

## 5. Plan de implementación

Un PR por paso hacia `development`, con *Squash and merge* y parada para aprobación entre pasos. Implementa
el agente `ejecutor`, verifica `verificador` y revisa `revisor` antes de abrir cada PR.

| Paso | PR | Contenido | Migración |
|---|---|---|---|
| 0 | `docs(seo): agrega el plan de la página de liga` | Este documento | No |
| 1 | `feat(seo): refuerza la página de liga` | L1 a L8: `seo-liga.ts`, `getLeagueRecentMatches`, plantilla, JSON-LD y tests | No |
| 2 | `fix(seo): corrige la nota de horarios en llms.txt` | `llms.txt` dice que todos los horarios están en hora de Argentina; desde docs/33 las páginas de equipo y de partido muestran la hora por país. Se corrige la frase. Google ignora `llms.txt` (docs/33 D12): es solo para que el archivo no afirme algo falso. | No |

Fuera de este plan, para decidir después con datos: hora por país en `/hoy` y `/partidos` (cada partido
tiene su propia hora, así que requiere otro diseño), y `docs/32` (ligas de Sudamérica).

## 6. Despliegue y rollback

- Sin migraciones, variables de entorno ni cambios de URL. Cada paso se revierte con un revert del PR.
- Lecturas de D1: una consulta más por visita a una página de liga (hasta 10 filas devueltas). La consulta
  busca por `league_id` con el índice `idx_matches_league_source` y ordena las filas de esa liga en memoria
  (no hay índice por liga y fecha); en una liga son unos cientos de filas por temporada. Si el plan de
  consulta mostrara un costo mayor, se evalúa un índice `(league_id, date_time)` en un PR aparte, con su
  migración.
- Verificación en staging después del merge y en producción con el smoke de `deploy.yml`; después, pedir la
  indexación de 3 o 4 páginas de liga en Search Console.

## 7. Riesgos

| Riesgo | Mitigación |
|---|---|
| Pocas impresiones de base: el efecto puede no verse en un mes. | Medir por periodos de 28 días en Search Console; no decidir por uno o dos clics. |
| `matches.round` con formatos distintos según la competencia o vacío. | Mostrarlo tal cual viene y omitirlo si falta; el test E2E cubre los dos casos. |
| Marcadores ausentes en partidos terminados. | Igual que en equipo: sin los dos goles se muestra "Terminado". |
| El refactor de L7 toca el JSON-LD de equipo. | Los tests actuales de equipo no cambian y deben seguir en verde. |
| Más filas leídas por visita con la cuota de D1 compartida con staging. | Tope de 10 filas, test de planes de consulta y la salida prevista en la sección 6. |

## 8. Notas de implementación

### Paso 1 · `feat(seo): refuerza la página de liga`

- **L2, la ronda va entre paréntesis** y sin artículo: "…es River Plate vs Boca Juniors (Fecha 16), el sábado…".
  El "por la Fecha 16" del diseño queda mal con "Octavos de final" o "Grupo A". Sin próximos y con un
  último resultado: "En el último partido, River Plate le ganó 2 a 1 a Boca Juniors el sábado…"; sin
  marcador, "El último partido fue River Plate vs Boca Juniors, el sábado…".
- **L3**: `getLeagueRecentMatches(db, leagueId, limit = 10, ahora)` pide `status = 'finished'`, fecha
  pasada y liga activa (igual que `getLeagueUpcomingMatches`). Plan: `SEARCH` por
  `idx_matches_league_source (league_id=?)`, sin `SCAN` y sin ir por `idx_matches_date`; sumado al test de
  planes. No hizo falta un índice nuevo. En la lista el marcador va con el local primero
  ("Boca Juniors 1, River Plate 2", `textoResultado`); sin los dos goles se muestra "X vs Y · Terminado".
- **L7**: el generador de eventos quedó en `seo.ts` como `jsonLdProximosPartidos` (tope
  `TOPE_EVENTOS_LISTA`), en lugar de `jsonLdPartidosDeEquipo` de `seo-equipo.ts`; el test de equipo solo
  cambió el nombre importado. Además se extrajo `fraseResultado` en `seo-partido.ts` ("X le ganó 2 a 1 a
  Y" / "X y Y empataron 1 a 1"), que usan `respuestaPartido` y `respuestaLiga`; los textos del partido no
  cambiaron.
- **Descripción**: pasó a `descripcionLiga` y empieza con "Fixture y partidos de" (antes "Fixture de").
- **Plantilla**: la respuesta (`.lg-respuesta`) y el renglón de horas (`.lg-horas`) van dentro de la sección
  "Próximos partidos". Sin próximos ya no se repite "No hay partidos programados…": lo dice la respuesta y
  queda "Podés explorar los equipos de esta competencia abajo". La ronda va delante de la fecha en cada
  renglón. "Últimos resultados" es una sección aparte entre los próximos y la lista de equipos.
- **Lecturas**: las cuatro consultas de la página (equipos, seguidos, próximos y resultados) ahora van
  juntas en un `Promise.all`; antes iban una detrás de otra.
- **E2E**: el partido neutral del servidor de E2E tiene ronda ("Fecha 3"). Se prueban la liga E2E (próximos
  y resultados), la liga neutral (ronda, sin resultados) y la copa E2E (sin partidos, sigue indexable). El
  caso "sin próximos pero con resultados" queda cubierto en los tests unitarios, no en E2E.
- **Verificación**: `npm run check` completo en verde (incluye `test:ux`).

### Paso 2 · `fix(seo): corrige la nota de horarios en llms.txt`

- La frase conserva "hora de Argentina (UTC-3)", que sigue valiendo para las listas, y agrega que las
  páginas de equipo, de liga y de partido indican además la hora del próximo partido en otros países. La
  de liga entra en la frase porque el paso 1 le sumó ese renglón (L4).
- Un test de integración (`sitemap-llms.test.ts`) fija la frase nueva.
- La línea de la sección 4 que nombraba `jsonLdPartidosDeEquipo` se ajustó: esa función pasó a
  `jsonLdProximosPartidos` (ver L7 arriba).
