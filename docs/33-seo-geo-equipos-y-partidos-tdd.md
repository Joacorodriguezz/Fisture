# 33 · SEO y GEO de equipos y partidos (TDD y plan de ejecución)

Estado: **aprobado el 13/11/2026; pasos 1 a 3 implementados**. Incluye D7 y D9, aprobadas por separado.
Continúa `docs/29` y `docs/30-plan-seo-antes-del-release-tdd.md`. Generado con la skill
`seo-geo-optimizer` (fases 1 a 4: cuestionario, competidores, mapa de palabras clave y este plan).

```
Producto:                 Fisture (fixture de fútbol sincronizado con Google Calendar y Outlook)
URL:                      https://fisture.com (producción)
Fecha del análisis:       13/11/2026
Buscadores:               Google y Bing
Objetivo GEO:             aparecer en AI Overviews / Modo IA de Google, Copilot, ChatGPT y Perplexity
Política de rastreadores: permitir todos (búsqueda, entrenamiento y pedidos de usuario); ver D7
Frases prioritarias:      "fisture" · "partidos de [equipo]" · "próximo partido de [equipo]" ·
                          "fixture de [equipo] en Google Calendar" · "[equipo 1] vs [equipo 2]"
Competidor principal:     fixtur.es (calendario, en español); Sync2Cal y FotMob como referencia
Stack y renderizado:      Astro SSR + islands de React en Cloudflare Pages
Madurez SEO:              intermedia (base técnica hecha en docs/29 y docs/30)

APROBADO POR:  dueño del producto            FECHA:  13/11/2026
```

## 1. Contexto y problema

El dominio tiene unas tres semanas. Search Console (25/10 al 10/11/2026, export del 13/11) muestra:

| Dato | Valor |
|---|---|
| Consulta `fisture` | 16 impresiones, 3 clics, posición 4,12 |
| Variantes mal escritas (`fixtura`, `fichure`, `fixure`…) | unas 80 impresiones, 0 clics |
| Páginas de equipo | 82 URLs con impresiones, 247 impresiones, 2 clics, posición media 53 |
| Páginas de partido | 95 URLs, 155 impresiones, 0 clics, posición media 21 |
| Home, `/hoy`, `/partidos`, `/ligas`, `/calendario` | 208 impresiones, 6 clics, posición media 5 |
| Dispositivo | 9 de 11 clics desde el celular |
| Países con clics | Argentina 5, Colombia 4, España 1, Venezuela 1 |

Google ya asocia las páginas de equipo con las frases buscadas ("partidos de aldosivi", "fixture river",
"velez cuando juega"), pero en posiciones 40 a 99. La base técnica está bien: canónicas, sitemap, robots,
datos estructurados y SSR. El problema es el contenido de las plantillas de equipo y de partido.

Comparación de la página de equipo con los competidores (HTML leído el 13/11):

| Sitio | Palabras | Qué muestra | Eventos en JSON-LD | URL |
|---|---|---|---|---|
| Fisture | ~160 | Próximo partido y lista de próximos | No | `/equipos/<uuid>` |
| fixtur.es | ~1.600 | Temporada completa con resultados, hora en la zona del visitante | Sí | `/es/team/celta-de-vigo` |
| Sync2Cal (inglés) | ~800 | Próximos eventos, qué recibís, preguntas, relacionados | Sí | `/…/river-plate` |
| FotMob | ~5.700 | Resultados, tabla, plantel | No | `/teams/161728/overview/aldosivi` |

No se midieron Core Web Vitals (PageSpeed sin clave no tiene cuota), enlaces entrantes ni tráfico de
terceros (no hay herramientas pagas). Los resultados de búsqueda consultados son de Estados Unidos.

## 2. Hallazgos críticos

1. **La página de equipo es corta y no responde la pregunta.** Solo lista lo que viene, y un equipo sin
   partidos programados queda vacío ("Todavía no hay partidos programados"). Costo según los datos
   propios: 247 impresiones en posición 53 con 2 clics. Google pide contenido útil y original, no una
   cantidad de palabras.
   [Contenido útil](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
2. **El título y el `<h1>` solo dicen "Fixture de X".** La mitad de las consultas son "partidos de X",
   "próximo partido de X" y "cuándo juega X".
   [Title links](https://developers.google.com/search/docs/appearance/title-link)
3. **Los partidos terminados no muestran el resultado y todo está en hora de Argentina.** El dato del
   resultado existe (`matches.home_score`, `away_score`) y no se publica. 6 de los 11 clics llegaron de
   otros países. [Guía de inicio](https://developers.google.com/search/docs/fundamentals/seo-starter-guide)
4. **La marca no existe fuera del sitio y Bing no está confirmado.** `PERFILES_DE_MARCA` está vacío.
   El índice de Bing alimenta a Copilot, y ChatGPT search puede consultarlo.
   [Bing Webmaster Guidelines](https://www.bing.com/webmasters/help/webmaster-guidelines-30fba23a) ·
   [OpenAI: ChatGPT search y Bing](https://help.openai.com/en/articles/10093903-chatgpt-search-for-enterprise-and-edu)
5. **El diferencial está escondido.** "Se agrega a tu calendario y se actualiza solo" es un enlace chico
   en la página de equipo. Google indica que el contenido único es lo que más influye en la presencia en
   sus respuestas con IA.
   [Guía de optimización para IA](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide)

## 3. Objetivos y no objetivos

**Objetivos (medidos en Search Console, periodos comparables de 28 días)**

- `fisture` entre las tres primeras posiciones, con el nombre del sitio bien mostrado.
- Subir la posición media de las páginas de equipo (hoy 53) y conseguir clics en equipos chicos y
  medianos. No se promete una posición: depende de Google y de la competencia.
- Aparecer por "fixture de [equipo] en Google Calendar" y similares.
- Quedar elegible para respuestas con IA: indexado en Google y en Bing, sin bloqueos de fragmentos.

**No objetivos**

- Top 10 en un mes para "fixture river" o "river vs boca": ahí compiten Promiedos, ESPN y medios con años
  de antigüedad. Se trabaja la cola larga.
- Resultados en vivo, tablas, planteles o notas periodísticas.
- Páginas nuevas generadas en masa (historial "X vs Y", una página por país o por variante de búsqueda):
  es abuso de contenido a escala según las
  [políticas de spam](https://developers.google.com/search/docs/essentials/spam-policies).
- Marcado `FAQPage` o `HowTo`: Google retiró esos resultados enriquecidos
  ([cambio de mayo de 2026](https://developers.google.com/search/updates#faq-deprecation)).
- Versión en otros idiomas, blog y publicidad paga.

## 4. Decisiones

| # | Decisión | Por qué | Alternativa descartada |
|---|---|---|---|
| D1 | **Título y `<h1>` de equipo** con las dos formas de búsqueda: título `Partidos y fixture de {equipo} - FISTURE`, `<h1>` `Fixture y partidos de {equipo}`. | Describe la página con las palabras que usa la gente, sin repetirlas. [Title links](https://developers.google.com/search/docs/appearance/title-link) | Una página por frase ("partidos de", "fixture de"): duplica contenido. |
| D2 | **Respuesta directa arriba** en equipo y partido: una oración completa, por ejemplo "Barracas Central juega su próximo partido el sábado 21 de noviembre a las 15:00 (hora de Argentina) contra Defensa y Justicia, de visitante, por la Liga Profesional". | Quien busca "cuándo juega X" obtiene la respuesta sin buscar de nuevo (heurística editorial). [Contenido útil](https://developers.google.com/search/docs/fundamentals/creating-helpful-content) | Bloque de preguntas frecuentes por equipo: texto repetido en 800 páginas. |
| D3 | **Últimos resultados en la página de equipo** (hasta 5 partidos terminados, con marcador si existe) y **resultado en la página de partido**. | Datos reales que ya están en D1 y hoy no se muestran; el equipo sin fixture deja de quedar vacío. | Temporada completa: más lecturas de D1 por visita sin evidencia de que haga falta. |
| D4 | **Hora por país** en el próximo partido del equipo y en la ficha del partido: Argentina, Uruguay y Brasil; Chile; Paraguay; Bolivia y Venezuela; Colombia, Perú y Ecuador; México; España. Renderizado en el servidor con `Intl` y agrupando los países que comparten hora. | El público es Sudamérica y España. El texto llega en el HTML, sin depender de JavaScript. [JavaScript SEO](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics) | Convertir en el navegador: el rastreador vería solo la hora argentina. Páginas por país: duplicados. |
| D5 | **Bloque "En tu calendario" visible** en la página de equipo: qué pasa al seguir al equipo (eventos en Google Calendar u Outlook, se actualizan solos, recordatorios) y botón de acción. | Es el diferencial y la intención de "fixture de X en Google Calendar". [Guía de IA](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) | Landing aparte por equipo y calendario: duplicaría la página de equipo. |
| D6 | **Próximos partidos como `SportsEvent`** en el JSON-LD de la página de equipo (hasta 10), reutilizando `jsonLdPartido`. | Describe los eventos a los buscadores; no garantiza resultado enriquecido ni mejora el ranking. [Datos estructurados](https://developers.google.com/search/docs/appearance/structured-data/intro-structured-data) · [schema.org/SportsEvent](https://schema.org/SportsEvent) | Dejarlo solo en la página de partido. |
| D7 | **Rastreadores de IA: se permiten todos** (estado actual de `robots.txt`: `User-agent: *` / `Allow: /`). | El objetivo es visibilidad en respuestas con IA; bloquear entrenamiento no cambia la inclusión en búsqueda. [OpenAI](https://developers.openai.com/api/docs/bots) · [Anthropic](https://support.claude.com/en/articles/8896518) · [Perplexity](https://docs.perplexity.ai/docs/resources/perplexity-crawlers) | Bloquear `GPTBot`, `ClaudeBot` y `Google-Extended`: decisión del dueño; hoy no hay motivo. |
| D8 | **Equipo sin ningún partido (ni próximo ni reciente): `noindex` y fuera del sitemap.** Vuelve a indexarse cuando tiene partidos. | Una página sin contenido puede tratarse como soft 404. [Robots meta](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag) | Devolver 404: el equipo existe y los usuarios pueden seguirlo. |
| D9 | **Nombre en la URL de equipos y ligas** (`/equipos/aldosivi`, `/ligas/liga-profesional-argentina`) con 301 desde la URL con UUID. Los partidos siguen con UUID. Aprobada el 13/11/2026. | URL legible para la persona y para compartir en X; Google recomienda URLs descriptivas, con efecto menor en ranking. Cambiarlas ahora cuesta menos que con más páginas indexadas. [Guía de inicio](https://developers.google.com/search/docs/fundamentals/seo-starter-guide) · [Redirecciones](https://developers.google.com/search/docs/crawling-indexing/301-redirects) | Slug en partidos: la fecha cambia con las reprogramaciones y la URL dejaría de ser estable. |
| D10 | **Enlaces a otros equipos de la misma liga** al pie de la página de equipo. | Enlaces rastreables con texto descriptivo entre páginas relacionadas. [Enlaces rastreables](https://developers.google.com/search/docs/crawling-indexing/links-crawlable) | Lista de todos los equipos del sitio. |
| D11 | **Sin `lastmod` en el sitemap** (se mantiene docs/29 C6) **e IndexNow diferido.** | No hay una fecha fiable por página; un `lastmod` impreciso se ignora. Con ~860 URLs, el sitemap importado en Bing alcanza para empezar. [Sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) · [IndexNow](https://www.indexnow.org) | Implementar IndexNow ahora: endpoint, script y workflow nuevos sin datos de Bing que lo justifiquen. |
| D12 | **`llms.txt` se deja como está.** | Google lo ignora; ni ayuda ni perjudica. [Guía de IA](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) | Ampliarlo. |

## 5. Plan por niveles

### Nivel 1 · Base (día 1; casi todo hecho)

| ID | Acción | Estado | Quién |
|---|---|---|---|
| T1-1 | Títulos, descripciones, canónicas, viewport | Hecho; se ajusta equipo (D1) | Código, paso 1 |
| T1-2 / T1-3 | `Organization` y `WebSite` en la home | Hecho; falta `sameAs` (T3-9) | — |
| T1-4 | Sitemap enviado en Search Console | Hecho (D11) | — |
| T1-5 | Bing Webmaster Tools: confirmar que la importación trajo el sitemap y que se procesó | **Pendiente** | Dueño |
| T1-6 / T1-7 / T1-8 | `robots.txt`, HTTPS, contenido en el HTML | Hecho | — |

### Nivel 2 · Rendimiento y página (semana 1)

| ID | Acción | Paso |
|---|---|---|
| T2-4 / T2-10 | D1 y D2 en equipo; D2 en partido | 1 y 2 |
| T2-1 a T2-3, T2-9 | Medir Core Web Vitals y Lighthouse móvil de home, un equipo y un partido. Solo se corrige si algo falla: LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1. [Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals) | Verificación del paso 1 |
| T2-5 / T2-6 / T2-8 | Open Graph, tarjeta de X y migas | Hecho |
| T2-12 | Revisar el texto alternativo de los escudos | 1 |

### Nivel 3 · Contenido y autoridad (semanas 2 y 3)

| ID | Acción | Paso |
|---|---|---|
| T3-5 | D3, D4, D5 y D8 | 1 y 2 |
| T3-8 | D10 | 4 |
| — | D9 (URLs con nombre) | 3 |
| T3-9 | Distribución: perfil de X antes de la Copa de la Liga; publicar enlaces a páginas de equipo y partido; directorios y comunidades de docs/29 A6. No es un factor de ranking: sirve para que la marca se descubra y se mencione. [Guía de IA](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide) | Dueño |
| T3-1 a T3-4, T3-6, T3-7 | No aplican (sin blog, sin autores, sin `FAQPage`) | — |

### Nivel 4 · GEO y visibilidad en IA (semanas 3 y 4)

| ID | Acción | Quién |
|---|---|---|
| T4-1 | Search Console: comprobar que el ajuste de IA generativa de la Búsqueda está en "Incluir" y que las páginas clave están indexadas. [Control en Search Console](https://support.google.com/webmasters/answer/16908024) | Dueño |
| T4-2 | Contenido propio: D2 a D5 | Código |
| T4-4 / T4-5 | D7; verificar que no haya `nosnippet` ni `noindex` accidentales (test) | Código, paso 1 |
| T4-6 | Agregar el perfil de X a `PERFILES_DE_MARCA` cuando exista. [Organization](https://developers.google.com/search/docs/appearance/structured-data/organization) | Código, cambio de una línea |
| T4-7 | `WebApplication` en la home | Hecho |
| T4-8 | Bing Webmaster Tools (T1-5); IndexNow diferido (D11) | Dueño |
| T4-9 | Línea base: informe de IA generativa de Search Console y "AI Performance" de Bing. [Informe de Google](https://support.google.com/webmasters/answer/16984139) · [Bing AI Performance](https://blogs.bing.com/webmaster/2026/2/Introducing-AI-Performance-in-Bing-Webmaster-Tools-Public-Preview/) | Dueño |

### Nivel 5 · Blog

No aplica: el sitio no tiene blog y no se crea uno.

## 6. Estrategia de tests (rojo, verde, refactor)

- **Unitarios (`lib/seo.ts`, `lib/format.ts`)**: título y descripción de equipo; oración de respuesta
  directa con y sin próximo partido, local y visitante; horas por país con agrupación y cambio de día
  (un partido a las 21:00 de Argentina cae al día siguiente en España); JSON-LD de equipo con eventos y
  tope de 10; slug estable con tildes, puntos y nombres repetidos.
- **Integración con D1 efímera**: últimos resultados (orden, tope, estados, marcador nulo); equipos del
  sitemap sin los que no tienen partidos; resolución por slug y por UUID.
- **E2E sin JavaScript** (suite SEO existente): la página de equipo contiene la respuesta directa, los
  resultados, las horas por país y el bloque de calendario; el partido terminado muestra el marcador;
  equipo sin partidos con `noindex`; la URL con UUID responde 301 a la URL con nombre; ninguna página
  pública lleva `nosnippet`.
- Cada paso corre `npm run check` antes del PR.

## 7. Plan de implementación

Planifica y revisa Fable; cada paso lo ejecuta Opus con esfuerzo medio. Un PR por paso hacia
`development`, con *Squash and merge*, y parada para aprobación entre pasos.

| Paso | PR | Contenido | Migración |
|---|---|---|---|
| 0 | `docs(seo): agrega el plan de SEO y GEO` | Este documento y la skill instalada | No |
| 1 | `feat(seo): refuerza la página de equipo` | D1, D2, D3 (equipo), D5, D6, D8 | No |
| 2 | `feat(seo): muestra resultado y hora por país` | D3 (partido), D4 | No |
| 3 | `feat(seo): usa el nombre en la URL de equipos` | D9: columna `slug` en `teams` y `leagues`, backfill, 301, enlaces internos, sitemap, canónicas y JSON-LD | **Sí** |
| 4 | `feat(seo): enlaza equipos de la misma liga` | D10 | No |

Tareas del dueño, fuera del código: T1-5, T4-1, T4-9, perfil de X, pedir la indexación de 5 a 10 páginas
de equipo después de cada despliegue y exportar Search Console una vez por semana.

## 8. Despliegue y rollback

- Los pasos 1, 2 y 4 son cambios de plantilla sin migración ni variables nuevas: se revierten con un
  revert del PR.
- El paso 3 agrega la migración `0016_slugs_equipos_ligas` (columna `slug` nullable con índice único en
  `teams` y `leagues`, sin backfill en SQL). Las URLs con UUID siguen respondiendo (con 301 cuando la fila ya
  tiene slug), así que no se rompen enlaces ni eventos de calendario ya creados. Orden real:
  1. **Migración** (la aplica `deploy.yml` antes de desplegar; es aditiva y el código anterior la ignora).
  2. **Deploy**. Hasta el backfill todo sigue igual que hoy: canónicas, sitemap y enlaces usan el id porque
     ninguna fila tiene slug (salvo competencias o equipos que el sync cree o atienda en el medio).
  3. **Backfill**: `POST /api/admin/slugs` (Bearer `ADMIN_SECRET`, `Content-Type: application/json`) repetido
     hasta `pendientes: 0` (~900 filas a 100 por llamada: unas 9 llamadas; docs/23 §6). Primero en staging.
  4. **Verificación**: `/sitemap.xml` con URLs con nombre; una URL vieja (`/equipos/<uuid>?lado=local`)
     responde 301 a `/equipos/<slug>?lado=local`; la canónica de la página con nombre es ella misma; pedir la
     indexación de 5 a 10 equipos en Search Console.
- Rollback: el código anterior no entiende slugs, y los navegadores y Google guardan las 301. Revertir el PR
  después del backfill deja 404 en las URLs con nombre ya compartidas. Si hiciera falta, lo seguro es un
  revert parcial que conserve la búsqueda por slug o id en `equipos/[id].astro` y `ligas/[id].astro` y quite
  la redirección; la columna y los slugs quedan (no molestan al código anterior). Antes del backfill, un
  revert simple alcanza.
- Staging sigue sin indexarse. La verificación en producción es el smoke de solo lectura de `deploy.yml`
  más la inspección de URLs en Search Console.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| Un mes es poco para ver cambios de posición en un dominio nuevo. | Medir por periodos de 28 días; no decidir por uno o dos clics. |
| D9 cambia las URLs de ~800 páginas recién descubiertas: Google tarda en reprocesarlas. | 301 permanentes, sitemap y canónicas actualizados en el mismo despliegue; es opcional y va último entre los cambios grandes. |
| Más lecturas de D1 por visita (resultados recientes, equipos de la liga) con cuota compartida con staging. | Consultas con índice y tope de filas; revisar `EXPLAIN QUERY PLAN` como en docs/30. |
| Marcadores ausentes o desactualizados según la fuente. | Mostrar el marcador solo si existe; no inventar datos. |
| Horario de verano en Chile, Paraguay, México y España. | Calcular con `Intl` y zona IANA, nunca con diferencias fijas; tests con fechas de ambos periodos. |
| Plantillas parecidas en 800 páginas. | El contenido sale de datos reales de cada equipo; no se crean páginas por variante de búsqueda. |

## 10. Notas de implementación

### Paso 1 · `feat(seo): refuerza la página de equipo`

- Textos en un módulo puro nuevo, `src/lib/seo-equipo.ts` (título, `<h1>`, descripción, respuesta
  directa, resultado desde el lado del equipo y eventos del JSON-LD), sumado a la cobertura de
  `vitest.config.ts`. La página `equipos/[id].astro` solo lo llama con los datos de D1.
- D2: la competencia va **sin artículo** ("por Liga Profesional Argentina", no "por la ..."): con
  "La Liga", "Brasileirão" o "Mundial de Clubes" un artículo fijo queda mal. Una sede que ya se nombra
  como estadio ("Estadio Monumental", "Emirates Stadium") no repite la palabra. Sin próximo partido
  programado (también si solo hay postergados) la oración dice "todavía no tiene un próximo partido
  confirmado" y, si existe, nombra el último resultado ("y ganó 2 a 0"); sin marcador lo omite.
- D3: `getTeamRecentMatches(db, teamId, limit = 5, ahora)` trae `status = 'finished'` con
  `date_time < ahora` (un "terminado" con fecha futura no cuenta). Plan: `MULTI-INDEX OR` sobre
  `idx_matches_home_team` e `idx_matches_away_team` y `TEMP B-TREE` para ordenar las filas del equipo;
  no usa `idx_matches_date`. En la lista el marcador va desde el lado del equipo ("Ganó 2-1"); sin los
  dos goles se muestra "Terminado". La sección solo aparece si hay resultados.
- D5: bloque "En tu calendario" entre el próximo partido y la lista, con enlace a `/calendario` y, sin
  sesión, el botón "Iniciá sesión". Reemplaza al aviso `.eq-aviso` (la clase pasa a `.eq-calendario`).
  El enlace a `/calendario` que estaba al pie del próximo partido se mudó al bloque.
- D6: los `SportsEvent` van como scripts JSON-LD aparte (después del `SportsTeam`, antes de las migas),
  solo los de estado `scheduled`, tope 10, sobre la lista sin filtrar por `?lado=`.
- D8: "sin partidos" = ninguno por jugar (cualquier estado, como la lista de próximos) y ninguno
  terminado. El sitemap usa la misma condición con un `EXISTS` correlacionado dentro de la consulta de
  equipos (una sola consulta, también por los índices de local y visitante). Por cada equipo lee sus
  partidos hasta encontrar uno que califique: más filas leídas que antes, pero acotadas por equipo.
- T2-12: sin cambios. El escudo conserva `alt=""` porque siempre va junto al nombre del equipo
  (criterio de docs/30); un texto alternativo repetiría el nombre a los lectores de pantalla.
- T4-5: E2E que verifica que `/equipos/river` no lleva `noindex`, `nosnippet`, `data-nosnippet` ni
  `X-Robots-Tag`. El servidor de E2E siembra dos resultados de River y un equipo sin partidos.

### Paso 2 · `feat(seo): muestra resultado y hora por país`

- Textos del partido en un módulo puro nuevo, `src/lib/seo-partido.ts` (`marcadorPartido`,
  `textoResultado`, `respuestaPartido`, `descripcionPartido`), sumado a la cobertura. `enLaSede` y
  `diaEnOracion` se exportan desde `seo-equipo.ts` en lugar de duplicarse. Sin consultas nuevas:
  `getMatchDetail` ya trae el marcador.
- D3 (partido): hay resultado solo con `status = 'finished'` y los dos goles cargados (un marcador de un
  partido en juego no se publica). Se ve en la ficha ("Resultado: Boca Juniors 1, River Plate 2") y en
  lugar del "VS" entre los escudos; ese marcador va con `aria-hidden` porque la ficha ya lo dice en
  palabras. La meta descripción de un terminado no invita a agendarlo: con marcador empieza por
  "Boca Juniors 1-2 River Plate por …: se jugó el …"; sin marcador dice cuándo se jugó. La de un
  cancelado dice "fue cancelado. Estaba previsto para el …" y la de un postergado "fue postergado y
  todavía no tiene nueva fecha. Si lo tenés en tu calendario, se actualiza solo." Las de programado y
  en juego no cambian.
- D2 (partido): una oración arriba de la ficha (`.fp-respuesta`) para cada estado: programado (o
  desconocido) "X y Y juegan el … por …, en el estadio …"; terminado "X le ganó 2 a 1 a Y el …" (el
  ganador primero, sea local o visitante) o "X y Y empataron 1 a 1 el …"; terminado sin marcador
  "X y Y jugaron el … El resultado todavía no está cargado."; en juego, postergado ("… fue postergado.
  La nueva fecha todavía no está confirmada.") y cancelado ("… fue cancelado.").
- D4: `horaPorPais(fecha)` en `format.ts`, con zonas IANA y `Intl`. Agrupa por hora local **y día
  calendario**, en el orden de `PAISES_HORA` (Argentina primero). Cada grupo trae `desfaseDias`
  (-1, 0 o 1 respecto de Argentina) y el día de la semana; `horaConDia` lo muestra como "01:00 del
  lunes". El día anterior también pasa: las 00:30 de Argentina son las 21:30 del día previo en México.
  Con el tzdata actual (Node 24, tz 2026b) Paraguay está en UTC−3 todo el año (cambio de 2024) y
  agrupa con Argentina también en julio; si el runtime tuviera un tzdata viejo lo mostraría una hora
  antes en invierno.
- Partido: sección "Hora en cada país" (lista) después de la ficha, salvo en cancelados y postergados,
  donde esa hora ya no vale (en terminados sí se muestra). El título dice "en cada país" porque incluye a
  Argentina. Equipo: renglón compacto debajo de la respuesta directa ("Hora en cada país: 15:00 en
  Argentina, Uruguay y Brasil; …") solo si hay próximo partido; el aviso pasa a "Los horarios de la lista
  de próximos partidos están en hora de Argentina (UTC−3)." (sin próximo queda el texto anterior).
- Enlaces: `<nav aria-label="Fixture de los equipos">` con "Fixture y partidos de {equipo}" para los dos.
  "Los horarios pueden cambiar…" ya no se muestra en partidos terminados ni cancelados.
- Sin cambios: la isla `SincronizarPartido` sigue ofreciendo agregar al calendario en partidos
  terminados y cancelados, y el JSON-LD de partido (un terminado sigue como `EventScheduled`, que
  schema.org no tiene un estado "terminado"; no contradice lo visible).
- Tests: unitarios de `seo-partido` y de `horaPorPais` (julio, enero, cambio de día hacia adelante y
  hacia atrás, agrupación por día); integración `tests/integration/seo/pagina-partido.test.ts` con
  `getMatchDetail`; E2E sin JavaScript en `seo-head.spec.ts` (programado, terminado con y sin marcador,
  cancelado y equipo) y `superclasico-ida` en el control de desborde móvil.
- Verificación: además de `npm run check`, se corre `npm run test:ux` (auditoría de UI), que es una
  suite aparte. En el paso 1 no se corrió y el CI falló por un test que buscaba el aviso viejo
  "Agregar al calendario"; se corrigió en un commit de tests del mismo PR.

### Paso 3 · `feat(seo): usa el nombre en la URL de equipos`

- **Migración `0016_slugs_equipos_ligas`** escrita a mano, como 0009 a 0015: `db:generate` no sirve en este
  repo (el snapshot de drizzle-kit quedó en la 0000 y generaría el esquema entero). El cambio del esquema se
  cubre con `drizzle/schema.ts` y el snapshot `esquema-drizzle.sql` (índices `teams_slug_idx` y
  `leagues_slug_idx`). Solo `ALTER TABLE ... ADD COLUMN slug TEXT` y `CREATE UNIQUE INDEX`; sin backfill.
- **Reglas puras en `src/lib/slug.ts`** (sumado a la cobertura): `slugificar` (minúsculas, NFD sin
  diacríticos, además `ß`→`ss`, `ø`→`o`, `æ`→`ae`, `ł`→`l` y similares que NFD no separa; todo lo demás a
  `-`), `resolverSlug` (base → `base-país` → `base-2`, `base-3`…; sin repetir el país si el nombre ya termina
  con él), `asignarSlugs` (en orden, reserva cada slug para las filas siguientes). Reservados: la forma de
  UUID, `buscar` e `index` (las únicas rutas fijas bajo `/equipos/` y `/ligas/` son `buscar.astro` e
  `index.astro`). Ejemplos: "Newell's Old Boys" → `newells-old-boys` (el apóstrofe se quita, como en
  `ohiggins`), "Liverpool" de Uruguay con el inglés ya cargado → `liverpool-uruguay`, un tercer "Nacional"
  sin país → `nacional-2`.
- **Ocupados por índice** (`src/lib/db/slugs.ts`): para cada slug base se leen las filas con `slug` o `id` en
  `[base, base.)`, que es exactamente la base y sus variantes `base-…` (`.` ordena justo después de `-`). Se
  miran también los ids porque la página busca `slug = ? OR id = ?`: un slug no puede ser el id de otra fila.
  25 bases por sentencia (4 parámetros cada una). Sin `LIKE` ni `SCAN` (test de planes).
- **Orden ante nombres repetidos**: el backfill recorre por `rowid` (orden de alta). El equipo cargado
  primero, que suele ser el de la liga que el sync recorre antes, se queda con el slug sin sufijo.
- **Nombre sin slug posible**: queda con la URL por id. El backfill solo toma filas con alguna letra o número
  ASCII (`name GLOB '*[A-Za-z0-9]*'`), así `pendientes` siempre llega a 0.
- **Sync**: equipos nuevos llevan el slug en el mismo `INSERT` (una lectura de ocupados cada 25 nombres
  nuevos, solo si hay equipos nuevos; cero escrituras extra). El `INSERT` de equipos pasó a
  `onConflictDoNothing({ target: external_id })`: un choque de slug falla a la vista en lugar de descartar el
  equipo en silencio, y la tanda pasó de 12 a 11 filas por el parámetro nuevo. A los equipos existentes sin
  slug el sync no les asigna: eso es del backfill, para no sumar subrequests al lote (docs/22 D4). Las
  competencias sí: el upsert devuelve el slug y las que no tienen se resuelven juntas al final de la
  invocación (una lectura y un batch; nada si todas tienen). Si eso falla se loguea `sync_slug_ligas_fallo`
  y el sync sigue. El slug no está en el `SET` del upsert: renombrar una competencia no lo cambia.
- **Backfill `POST /api/admin/slugs`**: Bearer `ADMIN_SECRET`, `withApi` con `rateLimit: []` como
  `encrypt-tokens` (los Bearer inválidos caen en `admin_fail`). Hasta 100 filas por llamada (ligas primero),
  escrituras condicionales `WHERE id = ? AND slug IS NULL`. Responde
  `{ asignados: { ligas, equipos }, pendientes, pendientesPorTabla }`. Sin cursor: las filas resueltas salen
  solas de la consulta. Unas 10 subrequests por llamada.
- **Rutas**: `getTeamBySlugOrId` / `getLeagueBySlugOrId` (una consulta, `MULTI-INDEX OR`, `LIMIT 2`; si el
  slug de una fila fuera el id de otra gana la del slug). `redireccionASlug` en `seo.ts` decide: por id y con
  slug → `Astro.redirect(..., 301)` con `Astro.url.search`; por slug o sin slug → la página; inexistente →
  `Astro.rewrite("/404")` como antes. El resto de la página usa `team.id` / `liga.id`, no el parámetro.
- **`rutaPublica`** ahora recibe `{ id, slug }` para equipos y ligas (sobrecargas de TypeScript: pasar un id
  suelto no compila) y un id para partidos. Pasan por ella: canónica (vía `Astro.url.pathname`), JSON-LD,
  migas, sitemap, `llms.txt`, home, ficha del partido, `/ligas`, `/ligas/[id]`, `/equipos/buscar` y la isla
  `FiltroEquipos` (recibe `ruta` armada en el servidor; no importa `seo.ts` al cliente). `getPaginasPublicas`,
  `getLigasPublicas`, `getEquiposParaExplorar` y las listas de equipos suman la columna `slug`; las que ya
  traían la fila completa no cambian. `GET /api/equipos/buscar` devuelve `slug` y `league.slug` (ninguna
  isla la consume hoy). Los eventos de calendario no enlazan a `/equipos/` ni `/ligas/`: no se tocaron.
- **E2E**: en el servidor de E2E, River, Boca y `e2e-league` tienen slug igual al id (las ~270 pruebas que
  navegan a `/equipos/river` siguen igual); `neutral-league` → `liga-neutral` y `neutral-home` →
  `equipo-neutral-local` prueban la 301 y los enlaces; `neutral-away` y `sin-partidos` quedan sin slug.

### Paso 4 · `feat(seo): enlaza equipos de la misma liga`

- **Consulta** `getEquiposDeLaLiga(db, leagueId, exceptoTeamId, limit = 40)` en `queries.ts`: `league_teams` con
  join a `teams`, sin el equipo actual, por nombre y luego id, y solo las columnas que usa la sección (`id`,
  `slug`, `name`, `shortName`, `logo`). Plan: `SEARCH league_teams USING COVERING INDEX
  sqlite_autoindex_league_teams_1 (league_id=?)`, `SEARCH teams` por su clave primaria y `TEMP B-TREE` para
  ordenar las filas de la liga (unas 20 a 30). Lee las participaciones de una liga y nada más. Se sumó al test
  de planes (`planes-de-consulta.test.ts`).
- **Cuándo aparece**: la página consulta solo si la liga principal (`team.leagueId`) existe, está activa y es
  destacada; si no, no hay lectura extra. La sección se muestra si hay al menos otro equipo. "La liga" son las
  participaciones (`league_teams`), no `teams.league_id`: entra un equipo que juega la liga aunque su liga
  principal sea otra, igual que la lista de `/ligas/[id]`. Los rivales de copas no se listan.
- **Orden**: `ORDER BY name` usa la colación binaria de SQLite, como `/ligas/[id]`: un nombre que empieza con
  tilde ("Águilas Doradas") queda al final. No se ordena en JavaScript para no desalinear el tope de 40 con el orden.
- **Plantilla**: sección al pie, después de "Últimos resultados", con `aria-label` y `BarraSeccion` en tono
  tinta: "Otros equipos de {liga}". Grilla `.eq-otros` (`global.css`): columnas de 220 px como mínimo en
  escritorio y dos columnas en móvil (≤ 640 px). Cada enlace (`.eq-otro`, alto mínimo de 48 px) lleva el
  `Escudo` de 36 px (32 en móvil) con `alt=""`, como el resto de la página (el nombre va al lado), y el nombre
  como texto. Sin logo, las iniciales del escudo bajan a 13 px porque las de 18 px no entraban en la caja. Al
  pie, "Todos los equipos y el fixture de {liga}" con `rutaPublica("ligas", liga)`. Sin islas ni JSON-LD nuevo.
- **E2E**: el servidor de E2E siembra "Talleres E2E" (`talleres-id`, slug `talleres-e2e`), que juega la liga E2E
  pero tiene como liga principal la copa no destacada. Así la página de River enlaza a `/equipos/boca` (slug),
  `/equipos/sin-partidos` (sin slug, por id) y `/equipos/talleres-e2e` (slug distinto del id), y la de Talleres
  no muestra la sección. El equipo neutral (sin `league_teams`) prueba la liga sin otros equipos. Talleres no
  tiene partidos: queda con `noindex` y fuera del sitemap, como "sin-partidos".
