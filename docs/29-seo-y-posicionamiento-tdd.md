# 29 · SEO y posicionamiento de marca (TDD)

Estado: **implementado en código (C1 a C5, más la meta de verificación)**. Diagnóstico actualizado el 08/11/2026 con Search Console; ver [plan posterior](30-plan-seo-antes-del-release-tdd.md). C6 y C7 quedan diferidos.

## 1. Contexto y problema

El diagnóstico inicial partió de una búsqueda manual donde Google sugería palabras similares a "fisture".
La evidencia de Search Console del 08/11/2026 confirma que la home está indexada, la propiedad está
verificada y el sitemap fue procesado correctamente. La consulta exacta `fisture` registra 14 impresiones,
2 clics y posición media 4,57. No corresponde inferir ausencia de indexación a partir de una búsqueda manual.

El paquete inicial mejora la consolidación del dominio, las descripciones y el texto visible de marca.
La siguiente etapa mejora contenido y enlaces internos. Google admite SVG: el PNG elegido es una opción
compatible, no una reparación de un formato prohibido. El reporte de cobertura aún no estaba disponible.

## 2. Lo que ya está bien (no tocar)

- `Layout.astro`: `<title>`, `meta description` recortada a 160, `canonical` absoluta desde `PUBLIC_APP_URL`,
  Open Graph y Twitter Card con imagen 1200×630, `lang="es"`, `noindex` en `/login`, `/configuracion` y en staging.
- `robots.txt` dinámico con `Sitemap:` y bloqueo de `/api/`; staging devuelve `Disallow: /`.
- `sitemap.xml` dinámico con ligas, equipos y partidos (hasta 50 000 URLs).
- JSON-LD (`lib/seo.ts`): `WebSite`, `Organization`, `WebApplication` en la home; `SportsEvent`, equipos y ligas
  en sus páginas.
- `llms.txt` para buscadores con IA.
- Páginas SSR: el contenido llega en el HTML, sin depender de JS.

## 3. Objetivos y no objetivos

**Objetivos**

- Mejorar la visibilidad de "fisture" y "fisture app", midiendo periodos comparables sin prometer posiciones ni plazos.
- Que Google indexe la home, las ligas y los equipos (medido en Search Console → Páginas).
- Aparecer por búsquedas de cola larga: "fixture de River en Google Calendar", "partidos de la Premier en mi
  calendario", "fixture Liga Profesional calendario".

**No objetivos**

- Publicidad paga (Google Ads).
- Un blog con mucho contenido editorial (se evalúa después de medir).
- Cambiar el nombre de la marca.

## 4. Decisiones

### 4.1 Fuera del código (lo más importante, lo hace el dueño del dominio)

| # | Acción | Por qué |
|---|--------|---------|
| A1 | **Completado: propiedad de dominio verificada en Search Console.** | Usar los informes existentes para medir cobertura y rendimiento. |
| A2 | **Completado: sitemap enviado y con estado Success.** | 860 URLs descubiertas en la lectura del 06/11; no equivale a 860 indexadas. |
| A3 | **Inspeccionar las páginas clave después de cambios significativos.** | Solicitar indexación puede avisar de cambios; no garantiza rastreo inmediato ni indexación. La home ya está indexada. |
| A4 | **Bing Webmaster Tools**: importar la propiedad desde Search Console. | Bing alimenta a DuckDuckGo, Ecosia, Copilot y ChatGPT search. Dos minutos de trabajo. |
| A5 | **Crear perfiles de marca** con el nombre "Fisture" y enlace a `fisture.com`: Instagram, X, TikTok, LinkedIn y GitHub (README del repo). | Son las señales que le enseñan a Google que "fisture" es una marca y no un error de tipeo. Se enlazan desde el JSON-LD (`sameAs`, §4.2). |
| A6 | **Conseguir los primeros enlaces externos**: Product Hunt, publicaciones en Reddit (r/futbol, r/argentina, subreddits de clubes), foros de hinchas, grupos de WhatsApp/Telegram, directorios de apps (AlternativeTo, SaaSHub), Google Business Profile si aplica. | Un sitio nuevo sin enlaces entrantes tarda mucho en rankear, incluso por su propio nombre. |
| A7 | Revisar en Cloudflare que **HTTPS esté forzado** y que `www.fisture.com` redirija con 301 a `fisture.com`. | Evita versiones duplicadas del sitio. |

### 4.2 En el código

| # | Cambio | Por qué | Alternativa descartada |
|---|--------|---------|------------------------|
| C1 | **Redirigir 301 `fisture.pages.dev` → `fisture.com`** en el middleware cuando `ENVIRONMENT === "production"` y el host no coincide con `PUBLIC_APP_URL`. | Hoy el mismo sitio se sirve en dos dominios. La canónica ayuda, pero una 301 consolida todo y evita que Google indexe el subdominio de Pages. | Una regla de *Bulk Redirects* en Cloudflare: funciona igual, pero queda fuera del repo y sin test. Queda como respaldo. |
| C2 | **`alternateName` y `sameAs` en `Organization` y `WebSite`** (`jsonLdSitio`): `alternateName: ["Fisture", "Fisture app", "Fixture Sync"]` y `sameAs` con los perfiles de A5. | Le dice explícitamente a Google cómo se llama el sitio y qué perfiles son suyos; ayuda a mostrar "Fisture" como nombre del sitio en los resultados. | Ninguna: es la vía documentada por Google. |
| C3 | **Logo PNG en `Organization.logo`** (`/icon-512.png`). | Imagen de marca con dimensiones explícitas. SVG también es compatible; se mantiene la decisión de usar PNG. | — |
| C4 | **Descripciones propias** en `/hoy`, `/partidos`, `/ligas`, `/calendario` y `/equipos/buscar`. | Hoy heredan la descripción genérica del layout: Google ve páginas casi iguales. | — |
| C5 | **Texto en la home que contenga la marca y las búsquedas objetivo**: un `<h1>` o bajada con "Fisture" escrito como palabra (no solo como logo) y un párrafo con "fixture de fútbol en Google Calendar / Outlook". Sumar a la home un bloque de preguntas frecuentes con `FAQPage` (las de `/ayuda`). | La palabra "Fisture" tiene que aparecer en texto. Las preguntas atrapan búsquedas de cola larga. | Una landing aparte por liga: se evalúa con datos de Search Console. |
| C6 | **Diferido: índice de sitemaps y `lastmod` fiable.** | Mantener un archivo mientras alcance. `lastmod` debe corresponder a cambios significativos del contenido; la fecha del build no sirve como sustituto. Por ahora se omite. | Dividirlo cuando ayude a medir cobertura o por límites de tamaño. |
| C7 | (Opcional) **IndexNow**: avisar a Bing/Yandex de las URLs nuevas al terminar el sync diario. | Indexación casi inmediata en Bing. Google no lo usa. | — |

### 4.3 Herramientas y skills

- No hay skills de SEO instaladas en esta cuenta de Claude (búsqueda sin resultados). Lo que sí sirve:
- **Google Search Console** (gratis): indexación, consultas, errores. Es la herramienta principal.
- **Bing Webmaster Tools** (gratis).
- **Rich Results Test** (`search.google.com/test/rich-results`) y **Schema Markup Validator** para el JSON-LD.
- **PageSpeed Insights / Lighthouse** (sección SEO y Core Web Vitals). Lighthouse puede correrse en CI con el
  Chromium que ya usa Playwright.
- **Cloudflare Web Analytics** (gratis, sin cookies) para medir tráfico orgánico.
- Opcionales de pago o freemium para auditoría: Ahrefs Webmaster Tools (gratis con el sitio verificado),
  Screaming Frog (gratis hasta 500 URLs).

## 5. Estrategia de tests

Test primero (rojo, verde, refactor), con Vitest y Playwright como el resto del proyecto:

- **C1**: test del middleware: pedido a `https://fisture.pages.dev/ligas?x=1` en producción → 301 a
  `https://fisture.com/ligas?x=1`; en staging y en `localhost` no redirige; `/api/*` tampoco (los webhooks y el
  sync usan `PUBLIC_APP_URL`, pero el test lo deja asentado).
- **C2/C3**: test de `jsonLdSitio`: incluye `alternateName`, `sameAs` y un `logo` que termina en `.png`.
- **C4**: E2E que recorre las páginas públicas y verifica que cada `meta description` sea distinta y no vacía.
- **C5**: E2E: la home contiene el texto "Fisture" fuera del logo y un JSON-LD `FAQPage` válido.
- **C6**: test del índice de sitemaps: cada `<loc>` es absoluta, con `PUBLIC_APP_URL`, y responde XML.
- Un E2E de humo de SEO: ninguna página pública tiene `noindex` en producción, todas tienen canónica.

## 6. Plan de implementación

1. **Semana 0 (sin código, hoy mismo)**: A1 a A4 y A7. Es lo que más impacto tiene.
2. PR 1 `fix(seo): redirige pages.dev al dominio propio` (C1).
3. PR 2 `feat(seo): agrega alternateName y sameAs` (C2, C3) — requiere las URLs de los perfiles de A5.
4. PR 3 `feat(seo): agrega descripciones por página` (C4).
5. PR 4 `feat(ui): suma texto de marca y FAQ a la home` (C5).
6. PR 5 `feat(seo): divide el sitemap en un índice` (C6).
7. Semanas 1 a 8: A5 y A6 en paralelo; revisar Search Console cada semana (páginas indexadas, consultas con
   "fisture", CTR).
8. Con datos: decidir C7 y si vale la pena contenido editorial (por ejemplo "cómo agregar el fixture de tu equipo
   a Google Calendar").

## 7. Despliegue y rollback

- Ningún cambio requiere migraciones de D1 ni variables nuevas (los perfiles de `sameAs` van como constante).
- C1 es el único con riesgo: si la redirección rompe algo (por ejemplo, el callback OAuth de algún cliente
  configurado con `pages.dev`), se revierte el PR o se desactiva con la condición de `ENVIRONMENT`.
- Los cambios de JSON-LD y descripciones se revierten sin efectos secundarios.

## 8. Riesgos

| Riesgo | Mitigación |
|--------|------------|
| Google sigue corrigiendo "fisture" → "fissure" aunque el sitio esté indexado. | Es lo esperable al principio; se resuelve con señales de marca (A5, A6, C2). Medir también "fisture app" y "fisture fixture". |
| La redirección C1 afecta a staging. | Condición explícita `ENVIRONMENT === "production"` y test que lo cubre. |
| Miles de páginas de partidos de poco valor diluyen la calidad del sitio. | Revisar en Search Console "Rastreada, sin indexar"; si pasa, sacar los partidos del sitemap y dejar solo ligas y equipos. |
| El sitemap supera los 50 000 URLs. | El índice de C6 lo divide. |

## 9. Notas de implementación

Auditoría hecha con el skill `seo-audit` de coreyhaines31/marketingskills (MIT, el más instalado de skills.sh),
copiado en `.claude/skills/seo-audit/`. Se recorrieron las páginas públicas del build local con Playwright
(título, descripción, H1, canónica, `alt`, JSON-LD, status).

Hallazgos que no estaban en el plan original:

- **Soft 404**: un id inexistente en `/ligas/[id]`, `/equipos/[id]` y `/partidos/[id]` respondía 302 al listado.
  Salir de la ventana de 60 días del sitemap no elimina la ficha: `getMatchDetail` busca por ID. Para IDs inexistentes se hace `Astro.rewrite("/404")`: página
  `src/pages/404.astro` propia, status 404 y `noindex`, con enlaces a las secciones. Las rutas desconocidas usan
  la misma página (antes era la 404 por defecto de Astro, sin layout).
- `/equipos` redirigía con 302 a `/ligas`: pasa a 301.
- Siete páginas compartían la descripción genérica, no solo las cinco previstas: también `/privacidad` y
  `/terminos`.

Desvíos respecto del diseño:

- C1 vive en `destinoDominioCanonico` (`lib/seo.ts`) y en un middleware `dominio` entre `seguridad` y `sesion`:
  la 301 sale con headers de seguridad y sin consultar D1. Además de pages.dev y www, cubre los alias de cada
  deploy (`<hash>.fisture.pages.dev`) y http → https. Con una `PUBLIC_APP_URL` inválida no redirige.
- C2: `sameAs` sale de `PERFILES_DE_MARCA`, que está vacía. La clave no se publica hasta cargar perfiles
  reales (A5). `Organization` suma `email` de contacto.
- C3: el logo es un `ImageObject` con `icon-512.png` (512×512).
- C5: en lugar de un `FAQPage` en la home (ya existe en `/ayuda` y duplicarlo no suma) se agregó la sección
  "Qué es Fisture" (H2) con la marca en texto, las búsquedas objetivo y enlaces internos a Hoy, Partidos, Ligas
  y Buscar.
- Nuevo: `GOOGLE_SITE_VERIFICATION` y `BING_SITE_VERIFICATION` (opcionales, en `[vars]`, no secretas)
  publican la meta de verificación de cada consola, para quien no quiera verificar por DNS. Nunca en staging.
- No se hicieron C6 (índice de sitemaps) ni C7 (IndexNow): conviene decidirlos con los datos de Search Console.
  IndexNow además gasta subrequests del plan Free en el sync.
