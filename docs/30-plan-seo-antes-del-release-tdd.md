# 30 · Plan de SEO y contenido antes del release (TDD)

Estado: **alcance reducido implementado localmente; integración y staging pendientes**.
Fecha: 8 de noviembre de 2026.
Base revisada: `development`, commit `5b62834`, incluido en el release abierto #75 hacia `main`.
Este documento complementa y corrige el diagnóstico de `docs/29` con datos de Search Console.

### Corte aprobado el 08/11/2026

Después de revisar la utilidad de las guías, se acordó concentrar las instrucciones en `/calendario`
y diferir `/guias` y las dos guías por proveedor. Se implementan rastreo de login, contenido de equipos,
ligas y partidos, enlaces internos desde home/Ayuda y explicación pública de Calendario. Las secciones
siguientes conservan el plan amplio como referencia; los puntos exclusivos de guías no son requisitos
de este corte. No se crean URLs nuevas ni se cambia el sitemap porque las páginas ya estaban incluidas.
El despliegue y la verificación de staging/producción siguen pendientes de integrar la rama.

## 1. Decisión propuesta

Completar antes del release una mejora acotada de rastreo, contenido público y navegación:

1. Corregir el bloqueo de rastreo del login y actualizar las afirmaciones incorrectas del documento anterior.
2. Mejorar las páginas existentes de equipos, ligas y partidos utilizando los datos disponibles.
3. Convertir la vista pública de Calendario en una explicación útil del producto.
4. Publicar tres páginas de guías y enlazarlas desde la home, Calendario y Ayuda.
5. Añadir enlaces a equipos destacados y validar metadatos, sitemap y rendimiento móvil.
6. Ejecutar la suite del release y comprobar staging antes de integrar a producción.

El paquete propuesto no requiere migraciones de base de datos, nuevas cuentas externas ni nuevos secretos.
Las optimizaciones que requieran esos cambios se separarán del paquete para revisar su costo y riesgo.
El plan es de código y contenido dentro del repositorio. Perfiles sociales, acuerdos con comunidades y
envíos manuales a buscadores quedan como tareas externas y no bloquean la entrega.

## 2. Evidencia y límites del diagnóstico

Fuente: exportación entregada por el usuario `fisture.com-Performance-on-Search-2026-11-08.zip`.
El filtro indica 28 días, pero `Chart.csv` contiene 13 fechas, del 25/10 al 06/11/2026.

| Dato | Resultado | Consecuencia |
| --- | --- | --- |
| Total del sitio | 9 clics, 512 impresiones, CTR 1,76 %, posición media aproximada 30 | Línea base previa al PR; no mide su impacto |
| Consulta exacta `fisture` | 14 impresiones, 2 clics, posición 4,57 | La marca ya aparece en Google |
| Home inspeccionada | Indexada, canónica elegida igual a la declarada | No hay que rehacer la verificación de propiedad |
| Sitemap en Search Console | Success, 860 URLs descubiertas en la lectura del 06/11 | Descubrimiento no equivale a indexación completa |
| Móviles | 8 de 9 clics | Priorizar validación móvil sin atribuir causalidad al dispositivo |
| Login y dos variantes | 21 impresiones, 0 clics | Revisar exclusión del índice y permitir lectura de `noindex` |
| Consultas exportadas | 140; 134 con tres impresiones o menos | Evitar decisiones por variaciones de uno o dos clics |

Las consultas visibles suman 2 clics y 240 impresiones; las consultas anonimizadas no se muestran.
Las filas de páginas suman 604 impresiones porque se agregan por URL, frente a las 512 por propiedad.
No se sumarán ambos desgloses ni se inferirá una relación consulta–página que el ZIP no contiene.
El reporte de páginas no indexadas aún estaba procesándose: no hay diagnóstico de cobertura completo.
El ZIP permanece como archivo local del usuario; no incorporarlo al commit del plan ni a la aplicación.

### Lo que ya está implementado en el PR #75

SSR, títulos y descripciones, canónicas, Open Graph, JSON-LD de sitio/equipos/partidos, sitemap,
robots por entorno, 301 al dominio principal en producción, 404 reales para IDs inexistentes,
texto de marca en la home y verificaciones opcionales de buscadores. Estas piezas se conservan y verifican.

### Correcciones del diagnóstico anterior

- Google admite SVG. Mantener el PNG del logo es válido; eliminar la afirmación de que el SVG se ignora.
- `lastmod` debe reflejar un cambio significativo del contenido, no cada build. Por ahora se omite.
- Salir de la ventana del sitemap no borra una ficha de partido. `getMatchDetail` consulta por ID.
- Search Console y el sitemap ya están configurados. No afirmar que falta indexación por ausencia de evidencia en el repo.
- El puesto 1 en un plazo fijo no es un criterio de aceptación controlable por código.
- Las guías y preguntas frecuentes se justifican por su utilidad; no prometer resultados enriquecidos FAQ.

## 3. Objetivos y alcance

### Objetivos verificables

- Toda página destinada a búsquedas entrega contenido útil en el HTML sin sesión ni JavaScript.
- Login permite rastreo y devuelve `noindex`, incluidas sus variantes con `next`.
- Equipos responden de inmediato quién juega, cuándo, contra quién y en qué torneo.
- Ligas muestran próximos encuentros, además de participantes.
- Las guías explican los flujos reales de Google Calendar y Outlook y sus límites.
- Las nuevas páginas tienen enlaces internos, metadatos propios y entrada en sitemap.
- La experiencia autenticada, la sincronización y el entorno de staging siguen funcionando.

### Fuera del paquete previo al release

- Migración masiva de UUID a slugs; nuevas integraciones de calendarios o proveedores de fútbol.
- Páginas por cada combinación de equipo, torneo, país, fecha y proveedor de calendario.
- Feed de suscripción ICS público, indexación de APIs o atribución individual del tráfico orgánico.
- Índice de sitemaps, IndexNow y nuevas bases de datos de analítica.
- Un blog generalista o textos generados en masa para completar palabras clave.

## 4. Páginas y arquitectura de contenido

| Ruta | Acción | Intención principal y contenido |
| --- | --- | --- |
| `/` | Mejorar | Explicar Fisture, mostrar equipos destacados, enlazar Calendario y guías |
| `/calendario` | Ampliar la vista sin sesión | Cómo funciona el producto, proveedores, permisos, sincronización, CTA |
| `/equipos/[id]` | Mejorar plantilla | Próximo partido y fixture del equipo, competencias y acceso al calendario |
| `/ligas/[id]` | Mejorar plantilla | Próximos partidos de la competencia y equipos participantes |
| `/partidos/[id]` | Ajustar | Fecha, año, horario argentino, estado y metadatos específicos |
| `/hoy`, `/partidos` | Revisar | Mantener navegación temporal y listados públicos claros |
| `/ayuda` | Actualizar enlaces y copy | Soporte y respuestas breves; derivar a procedimientos detallados |
| `/guias` | **Nueva** | Índice breve de los dos procedimientos disponibles |
| `/guias/fixture-google-calendar` | **Nueva** | Agregar partidos y seguir equipos con Google Calendar |
| `/guias/fixture-outlook` | **Nueva** | Agregar partidos y seguir equipos con Outlook |

Las guías son páginas Astro con contenido versionado, sin CMS ni dependencia de React.
Un `GuiaLayout.astro` puede compartir estructura, migas, fecha editorial y navegación; crear esta
abstracción únicamente para el contenido común real. Reutilizar el diseño Tribuna y componentes existentes.

### Contenido mínimo de cada guía

1. Qué permite hacer y qué cuenta necesita el usuario.
2. Pasos reales: iniciar sesión con el proveedor, elegir equipo/partido y agregarlo al calendario.
3. Diferencia entre seguir un equipo, activar auto-sync y agregar un partido individual.
4. Permisos solicitados, actualización diaria y tratamiento de reprogramaciones/cancelaciones.
5. Qué hacer ante falta de permisos o reconexión requerida y enlaces a Ayuda/Configuración.
6. CTA para buscar un equipo y enlace a la guía del otro proveedor.

Verificar cada instrucción contra el comportamiento actual. No prometer seguir una liga completa
con una acción si la implementación permite seguir equipos. Tampoco presentar la descarga `.ics`
como una suscripción que se actualiza sola: hoy la descarga requiere sesión y es una exportación.
Usar capturas propias con datos de prueba si aclaran los pasos; nunca cuentas o calendarios reales.
Las capturas son complementarias: el procedimiento debe entenderse en texto.

Evitar tres páginas que repitan el mismo texto: Calendario explica la propuesta; las guías enseñan
los pasos particulares; Ayuda responde dudas y problemas. Cada una tiene title, descripción y H1 propios.

## 5. Paquetes de implementación

### A. Rastreo y coherencia técnica — obligatorio

Archivos: `src/pages/robots.txt.ts`, `src/pages/login.astro`, `src/lib/seo.ts`,
`tests/unit/seo/robots.test.ts`, `tests/e2e/seo-head.spec.ts`, `docs/29`.

- Quitar únicamente `Disallow: /login` en producción. Conservar su meta `noindex`, también con query string.
- Conservar bloqueo de API y política de páginas personales; no usar robots como control de acceso.
- Mantener staging con `Disallow: /` y `noindex`. Conservar exclusión de APIs/mutaciones de la 301 de dominio.
- Corregir comentarios y documentación sobre SVG, lastmod, indexación actual y ventana de partidos.
- Verificar que 404 sea un estado HTTP real, sin depender de una frase en el HTML.
- Validar host canónico, www, pages.dev, ruta/query y ausencia de bucles de redirección.

Aceptación: un rastreador puede obtener `/login` y leer `noindex`; las rutas públicas válidas devuelven
200 sin `noindex` en producción; staging no se vuelve indexable.

### B. Fichas de equipos y partidos — prioridad alta

Archivos: `src/pages/equipos/[id].astro`, `src/pages/partidos/[id].astro`, `src/lib/seo.ts`,
`src/lib/format.ts` y componentes de presentación compartidos si evitan duplicación real.

- H1 descriptivo: `Fixture de {equipo}`; conservar nombre, escudo y controles actuales.
- Bloque `Próximo partido` construido con los datos ya consultados, sin otra consulta por tarjeta.
- Mostrar rival, torneo, fecha, hora y sede cuando exista; enlazar a la ficha del encuentro.
- El próximo partido se calcula sobre todos los encuentros del equipo, no sobre el filtro local/visitante.
- No anunciar como próximo partido confirmado uno cancelado, finalizado o postergado sin nueva fecha fiable.
  Revisar los estados disponibles y cubrir explícitamente la elección del encuentro accionable.
- En ausencia de datos: `Todavía no hay próximos partidos cargados`; no inventar fixture ni hora.
- Título de partido descriptivo con fecha/año cuando distinga cruces repetidos. Evitar truncados que eliminen
  al rival: los 60 caracteres son una guía editorial, no una regla de Google ni un motivo para mutilar nombres.
- Mostrar `Hora de Argentina (UTC−3)` y usar el formateador de Buenos Aires existente en SSR.
- Mostrar estado real y origen de datos con una etiqueta pública entendible. La fecha `updatedAt` solo se
  presentará como actualización del registro si su semántica se confirma; no llamarla última verificación oficial.
- Enlaces a guía de calendario, liga y rival con texto descriptivo.

Aceptación: bloque útil en HTML sin JS; nombres largos y pantallas angostas legibles; estados correctos;
seguir/agregar/quitar y sus permisos mantienen el comportamiento existente.

### C. Fixture de ligas y enlaces desde la home — prioridad alta

Archivos: `src/pages/ligas/[id].astro`, `src/pages/index.astro`, `src/lib/db/queries.ts`.

- Añadir consulta `getLeagueUpcomingMatches`: filtro por `leagueId`, rango temporal explícito, estados
  elegibles, orden por fecha e ID como desempate, `LIMIT 20`, joins de equipos en la misma consulta.
- Usar un rango inicial de 30 días; mostrar claramente que es una selección de próximos encuentros.
- No recuperar todos los partidos y filtrarlos en memoria ni hacer una consulta adicional por equipo.
- Mantener las tarjetas de participantes debajo del fixture. No atribuir a una liga los partidos de copas
  de sus equipos: el filtro debe ser por competencia del encuentro.
- Mostrar fecha, hora, local, visitante y enlace al partido; mensaje útil si no hay encuentros cargados.
- Home: hasta seis equipos destacados obtenidos en una consulta acotada por identificadores estables de
  proveedor y origen, disponibles en producción y staging. No usar UUID copiados del ZIP ni adivinar por nombre.
- Solo renderizar enlaces a registros existentes y elegibles. No etiquetar como populares si no hay medición.
- Añadir enlaces a `/calendario` y `/guias`; mantener la redirección actual de la home para usuarios autenticados.

Aceptación: fixture de la liga correcto sin N+1; ninguna tarjeta rota; estado vacío válido con fixtures de test.
Revisar el plan de consulta sobre D1 local. Si hace falta un índice nuevo, abrir un cambio separado con migración
y revisión de costos; no introducirlo de forma implícita en este paquete sin migraciones.

### D. Calendario público y guías — prioridad alta

Archivos: `src/pages/calendario.astro`, tres nuevas rutas en `src/pages/guias/`,
`src/pages/ayuda.astro`, `src/layouts/Layout.astro` y, si aplica, layout de guía.

- Ampliar exclusivamente la rama pública de Calendario con funcionamiento, proveedores, permisos y límites.
- Mantener el panel autenticado y las acciones de sincronización; no guardar HTML personalizado en caché pública.
- Implementar las tres páginas y el contenido de §4 con enlaces hacia acciones existentes.
- Mantener información sustancial de guías accesible para usuarios con y sin sesión.
- Agregar navegación `Guías` desde Ayuda y el pie; no sobrecargar el menú móvil principal.
- Capturas optimizadas con dimensiones, alt descriptivo y carga diferida cuando estén fuera de pantalla.

Aceptación: navegación completa sin sesión, sin enlaces a funciones inexistentes, CTA con retorno adecuado,
contenido legible en móvil y ninguna regresión en el panel personal.

### E. Metadatos, parámetros, sitemap y datos estructurados — obligatorio para lo nuevo

Archivos: `src/lib/seo.ts`, `src/layouts/Layout.astro`, `src/pages/sitemap.xml.ts`, páginas y tests de SEO.

- Incorporar las tres nuevas URLs al sitemap existente; mantener absolutas, únicas, canónicas y 200.
- Mantener un sitemap único en este release. No usar fecha del build para `lastmod`.
- Verificar title, descripción, H1, OG y canónica propios por página; no usar el mismo title para ambas guías.
- Añadir BreadcrumbList a guías y mantener consistencia con migas visibles. No agregar schema ficticio,
  reseñas, dirección de estadio, emisoras o disponibilidad de entradas que los datos no acrediten.
- Revisar SportsEvent en postergados/cancelados y mantener JSON-LD consistente con el contenido visible.
- Mantener `sameAs` omitido mientras no existan perfiles oficiales confirmados.

Política de parámetros:

| Variante | Tratamiento |
| --- | --- |
| `utm_*`, parámetros de tracking | Canónica a la ruta sin tracking; nunca en sitemap |
| Equipo `?lado=local/visitante` | Conservar filtro y canónica al fixture completo; no redirigir ni bloquear rastreo |
| Login `?next=...` | Conservar retorno, `noindex`, permitir rastreo; nunca en sitemap |
| Buscar equipo con `q` o liga | Conservar utilidad de búsqueda; no crear páginas SEO adicionales ni incluir variantes en sitemap |
| Hoy con `fecha` | Revisar por separado: representa contenido de otro día, no asumir que es duplicado de hoy |

Antes del release verificar las variantes actuales. El cambio de política de fechas o búsquedas internas se
pospone hasta revisar cobertura: el ZIP muestra URLs con parámetros, pero no prueba su canónica actual elegida.
No agregar masivamente `noindex` ni bloquear parámetros para intentar resolver impresiones históricas.

### F. Rendimiento y accesibilidad móvil — validación obligatoria, optimización dirigida

Archivos posibles: `src/layouts/Layout.astro`, `src/components/tribuna/Escudo.astro`,
componentes React de escudos, CSS y assets de guías.

- Medir home, Hoy, equipo, liga, Calendario público y una guía en el mismo entorno y configuración móvil.
- Registrar mediana de tres corridas Lighthouse por página, LCP, CLS, TBT y bytes transferidos como datos de laboratorio.
  TBT no es INP. Consultar CrUX/Search Console para datos de campo si hay muestra suficiente.
- Objetivos de campo orientativos: LCP ≤ 2,5 s, INP ≤ 200 ms, CLS ≤ 0,1 en percentil 75.
- Revisar fuentes: familias/pesos utilizados, bloqueo de render y alternativa local WOFF2 con licencia apropiada.
  Aplicar el cambio solo si medición y comparación visual lo justifican.
- Revisar escudos: el componente actual aplica lazy a todos. Si una imagen resulta ser el LCP, permitir carga
  inmediata para esa imagen, conservando lazy para listados. Reservar dimensiones.
- Conservar alt vacío cuando el escudo es decorativo junto al nombre; añadir descripción cuando aporte información.
- Evitar nuevas islas React para contenido estático. Verificar teclado, foco, enlaces y ausencia de desbordes.
- Comparar contra la base bajo el mismo perfil. Una regresión repetible superior al 10 % en LCP o bytes
  de una ruta modificada requiere explicación/corrección; es un umbral de revisión interno, no una regla SEO.

No condicionar el release a disponer de 28 días de datos de campo ni a un puntaje Lighthouse de 100.

## 6. Orden, dependencias y tamaño de entrega

| Entrega | Contenido | Depende de | Esfuerzo relativo | Corte propuesto |
| --- | --- | --- | --- | --- |
| PR A | Login, documentación y regresiones de rastreo | Base #74 | Bajo | Antes del release |
| PR B | Equipos y partidos | A | Medio | Antes del release |
| PR C | Fixture de ligas y destacados de home | B para reutilizar presentación | Medio | Antes del release |
| PR D | Calendario público y tres guías | Flujos actuales verificados | Medio | Antes del release |
| PR E | Sitemap, enlaces y metadatos de todas las rutas nuevas | C y D | Bajo | Antes del release |
| PR F | Correcciones de rendimiento medidas y validación final | B–E | Variable | Corregir regresiones antes del release |

Las guías y su entrada de sitemap deben integrarse en una misma entrega funcional: E puede incluirse en D
para evitar publicar páginas huérfanas. Los nombres de PR son orientativos; dividir por cambios revisables.
La estimación relativa incluye tests. Las capturas de guías y una eventual optimización de fuentes son
los puntos más variables. No se fija una fecha hasta acordar el corte del release.

Si hay que recortar alcance, integrar A y conservar las mejoras existentes de #75; publicar B–F en un
release posterior. Si se aprueba el paquete completo, el release espera a las aceptaciones de A–F.
No bloquear una corrección técnica por esperar crecimiento de tráfico.

## 7. Estrategia de pruebas

Para cambios de comportamiento: prueba que reproduce el caso, implementación y refactor.
No crear tests que solo comparen literalmente párrafos editoriales o dupliquen la implementación.

| Área | Prueba significativa |
| --- | --- |
| Robots/login | Producción permite `/login` y sus variantes, respuesta contiene noindex; staging sigue cerrado |
| Canónicas y redirecciones | GET/HEAD al alias, host correcto, query conservada, API y mutaciones excluidas, sin bucles |
| Consulta de liga | Torneo correcto, exclusión de otras copas, límite/orden, bordes temporales, estados y vacío |
| Próximo partido | Datos sin encuentros, cancelación, postergación, local/visitante y nombres largos |
| Guías | Tres rutas 200, contenido SSR, navegación por teclado, enlaces y CTA válidos sin sesión |
| Metadatos | Canónicas absolutas, títulos distintos, JSON-LD parseable y coherente, sitemap sin duplicados ni login |
| Sesión | Calendario personal y acciones existentes conservados, retorno del login y ausencia de datos personales en HTML público |
| Accesibilidad | Móvil/escritorio, foco, headings y dimensiones; contraste y desbordes con suite UX existente |

Usar Vitest con D1 efímera y Playwright con el servidor de fixtures existente. Incluir nuevas rutas
en `tests/e2e/seo-head.spec.ts` y casos de integración en la organización actual de tests.
No se requieren credenciales reales de calendarios para correr CI. Validar las instrucciones de las guías
contra el flujo probado de la app; cualquier comprobación externa pendiente queda explícita en el PR.

Checks finales: `npm run typecheck`, `npm run test:discover`, `npm run test:coverage`, `npm run build`,
`npm run test:e2e`, `npm run test:ux`, de acuerdo con `.github/workflows/test-suite.yml`.
Los checks anteriores del PR no sustituyen una ejecución sobre el commit final de este paquete.

## 8. Despliegue y rollback

1. Crear ramas de trabajo desde `development`, sin incluir el ZIP. PRs de implementación a `development`.
2. Coordinar con #76 (`perf/consultas-d1`): si se integra, revisar conflictos y planes de consulta en la base
   actualizada; no incorporar cambios de ese PR por accidente ni asumir que ya está desplegado.
3. Cada integración despliega staging. Verificar páginas sin sesión y con sesión, 404 y robots/noindex.
4. Actualizar descripción y alcance de #75, que sigue la rama `development`; congelar el SHA a validar antes del merge.
5. Confirmar CI completo del SHA final y la checklist manual. El merge del release y su despliegue se autorizan aparte.
6. Producción: comprobar `/api/health`, home, equipos, ligas, guías, login/noindex, sitemap, 301 de alias y 404.
7. Registrar fecha y SHA desplegado para la comparación posterior en Search Console.

Rollback: revertir el cambio afectado mediante PR o volver al artefacto previo desde Pages según el runbook.
El paquete no modifica el esquema ni datos de usuarios. Si se retiran guías ya publicadas, actualizar enlaces
y sitemap; usar 404 si no hay sustituta equivalente. No redirigir todas las páginas retiradas a la home.

## 9. Seguimiento posterior y segunda etapa

Comparar periodos equivalentes después de disponer de datos completos: marca exacta, páginas de equipos,
ligas y guías, segmentadas por país/dispositivo. Registrar impresiones y clics además de posición y CTR.
La muestra actual no permite prometer un aumento porcentual ni elegir ganadores por uno o dos clics.

| Mejora posterior | Diseño y condición para ejecutarla |
| --- | --- |
| Slugs legibles | Tabla de alias persistentes, unicidad por club/competencia, 301 de UUID y alias antiguos, actualización de enlaces/canónicas/sitemap; mantener IDs internos y APIs. Requiere TDD de migración |
| Sitemap por tipo | Índice y archivos de guías/equipos/ligas/partidos cuando ayude a medir cobertura o aparezcan límites de tamaño; evitar truncado silencioso |
| lastmod fiable | Definir qué cambios de partido, equipo, liga y contenido editorial modifican cada página y persistir la fecha significativa |
| Parámetros de fecha/búsqueda | Revisar canónicas elegidas y cobertura antes de decidir indexación propia o noindex; no confundir fechas diferentes con duplicados |
| Medición de conversiones | Reutilizar conteos agregados de `/api/admin/status`; para atribución orgánica hace falta diseño específico de eventos, retención y privacidad. Los conteos existentes no prueban origen orgánico |
| Horarios locales opcionales | Mantener hora argentina como base SSR y zona explícita; diseñar selector sin duplicar URLs ni alterar fecha del evento |
| Guía de ICS | Solo tras comprobar instrucciones para descarga autenticada e importación; explicar que el archivo no se actualiza solo |
| Rendimiento avanzado | Caché de datos públicos, índices y optimización de consultas solo con evidencia, sin cachear respuestas personalizadas |

## 10. Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| Contenido de guías promete funciones no implementadas | Revisar siguiendo/agregando con y sin auto-sync; documentar ICS como exportación |
| Guías duplican landing o Ayuda | Separar intención y enlazar explicaciones, sin copiar bloques enteros |
| El fixture de liga aumenta lecturas D1 | Consulta acotada con joins, medición local, sin N+1 y coordinación con #76 |
| Se presenta un partido cancelado como próximo | Selector por estado y tests de bordes; no inferir hora confirmada solo por tener dateTime |
| Metadatos horarios difieren del contenido | Reutilizar formateadores y datos de la ficha; pruebas con frontera de día UTC/Buenos Aires |
| Cambios visuales perjudican móvil | QA a los anchos del proyecto y pruebas UX sobre el artefacto final |
| Cambiar URLs rompe enlaces existentes | Mantener rutas actuales en este release; migración de slugs separada |
| Tráfico bajo genera falsas conclusiones | Comparar periodos suficientes y no fijar targets de ranking como gate del release |

## 11. Fuentes técnicas

- [Google: noindex y acceso del rastreador](https://developers.google.com/search/docs/crawling-indexing/block-indexing?hl=es).
- [Google: sitemaps y lastmod](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).
- [Google: títulos descriptivos](https://developers.google.com/search/docs/appearance/title-link).
- [Google: estructura de URLs](https://developers.google.com/search/docs/crawling-indexing/url-structure).
- [Google: imágenes y formatos compatibles](https://developers.google.com/search/docs/appearance/google-images).
- [Google: Core Web Vitals](https://developers.google.com/search/docs/appearance/core-web-vitals).
- [Search Console: discrepancias de agregación y consultas omitidas](https://support.google.com/webmasters/answer/17010575?hl=es).
- [Google: retirada de resultados enriquecidos FAQ](https://developers.google.com/search/updates).

## 12. Notas de implementación

- Rama `feat/seo-contenido-publico`, desde `development-2` en `5b62834`. Sin migraciones ni nuevas dependencias.
- Robots permite rastrear login para leer su `noindex`; staging sigue bloqueado.
- Equipos muestran próximo encuentro programado independientemente del filtro local/visitante.
- Ligas consultan hasta 20 partidos programados de los próximos 30 días, con joins y desempate por ID.
- Home incorpora hasta seis equipos de competencias activas destacadas, sin duplicados. Selección alfabética
  en lugar de una lista curada por externalId: evita depender de IDs/proveedores o atribuir popularidad sin datos.
- Partidos incorporan fecha con año al título y contenido, estado visible, fuente reconocida de datos
  (sin inventar etiquetas para fuentes desconocidas) y aclaración de fin estimado.
- Calendario público explica conexión, seguir vs auto-sync, actualización diaria, permisos y exportación ICS.
  La vista personal conserva su flujo. Home y Ayuda enlazan la explicación.
- La 404 deja de afirmar que salir de la ventana de 60 días elimina un partido.
- Se conserva un sitemap sin `lastmod` ficticio, las rutas UUID, los datos estructurados y las canónicas existentes.
- Tests nuevos: límites/estados/orden y competencias con D1 real; contenido público sin JavaScript y login con `next`.
- EXPLAIN QUERY PLAN sobre D1 efímera con las migraciones reales: el fixture usa `idx_matches_date` y
  las claves de liga/equipos; el desempate por ID usa una estructura temporal. La home usa `idx_teams_name` y EXISTS con
  `idx_league_teams_team`, evitando multiplicar filas y ordenar todas las participaciones con DISTINCT.
  Sigue siendo una sola consulta por página; no es una medición de latencia ni lecturas de producción.
- Validación local: typecheck sin errores (10 avisos de deprecación ya existentes), descubrimiento de 80
  archivos de test, 1.045 pruebas unitarias/integración aprobadas y un TODO preexistente; cobertura de líneas
  del conjunto crítico medido: 97,36 %. Build de producción correcto.
- Navegador: 81 E2E aprobados y 9 omitidos por dispositivo; 32 comprobaciones SEO aprobadas después de
  los ajustes de fuente de datos y consulta de portada. UX: 177 aprobados y 6 omitidos, con Chromium
  escritorio/Android y WebKit iPhone, ambos temas y anchos de 320 a 1280 px.
- El primer E2E se interrumpió por un error interno del proxy/inspector de Wrangler local. La ejecución
  completa con `--workers=1` pasó. No se modificó la infraestructura ni se actualizaron dependencias.
- La revisión de capturas detectó numeración de pasos anulada por el reset CSS y enlaces sin distinción
  visual. Se restauró `list-style: decimal`, se subrayaron los enlaces nuevos y se separaron los párrafos.
  Build final y 24 comprobaciones focalizadas de esas cuatro pantallas aprobados.
- El cambio posterior de la consulta de home a EXISTS pasó las 10 pruebas focalizadas de datos/robots,
  typecheck, build y los 32 E2E SEO. No cambia la salida visual ni agrega JavaScript.
- Pendientes externos al trabajo local: integrar la rama a `development`, CI del SHA integrado, revisar
  staging y autorizar el merge del release. Ningún despliegue realizado. No se atribuyen mejoras de ranking
  ni Core Web Vitals a estos cambios sin medición en producción.
- Preparación del PR: rama actualizada sobre cafe808 (accesibilidad, PR #77) sin conflictos.
