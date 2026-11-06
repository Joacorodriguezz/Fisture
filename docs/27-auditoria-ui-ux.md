# Auditoría UI/UX previa a producción

Fecha: 5 de noviembre de 2026. Aplicación: Fisture. Base del workspace: `c1b8cf541f13b74c0d7ed68699b933a96f5d8ef3`.

## Resultado y alcance

La auditoría encontró problemas concretos de accesibilidad, mensajes inconsistentes y fricciones en la búsqueda móvil. Se prepararon correcciones acotadas y pruebas de regresión en esta rama. **Este informe no autoriza todavía la salida a producción**: siguen pendientes las pruebas con personas, teléfonos reales, lector de pantalla y el recorrido completo con calendarios reales.

Se evaluaron dos entornos por separado:

- **Staging desplegado:** `https://development.fisture.pages.dev`, sin sesión, con contextos nuevos. Diez rutas públicas, dos temas y tres configuraciones de navegador: 60 combinaciones. Todas devolvieron HTTP 200 y ninguna desbordó horizontalmente. Axe detectó `link-in-text-block` en Ayuda en las seis combinaciones de tema/navegador. No se identificó el commit desplegado; no se supone que coincida con este workspace.
- **Build local:** Astro construido para producción, servido por Pages/Workers local, D1/KV descartables y usuarios de prueba independientes por proyecto. Chromium de escritorio, Chromium con parámetros de Pixel 7 y WebKit con parámetros de iPhone 13. Incluye estados personales y fallos controlados. Es emulación de navegador, no una prueba en teléfonos físicos.

Los endpoints de inicio OAuth de staging redirigieron a `accounts.google.com` y `login.microsoftonline.com` con HTTP 302. Esto confirma que ofrecen el inicio del recorrido; no valida el consentimiento, el callback ni la creación de eventos reales. No se otorgaron permisos a cuentas reales ni se modificaron calendarios externos.

Se revisaron visualmente las capturas de portada, login, Hoy, Ligas, búsqueda, equipo y partido. Los escudos diferidos que no se descargaron fuera del viewport no se clasificaron como defectos por aparecer vacíos en una captura de página completa.

Evidencia conservada en el repositorio:

- [Resumen de las 60 combinaciones y mediciones](ux-evidence/staging-summary.json).
- [Portada móvil desplegada](ux-evidence/portada-movil.png).
- [Búsqueda a 375 × 667](ux-evidence/busqueda-375x667.png).
- [Hoy a 375 × 667](ux-evidence/hoy-375x667.png).
- [Menú corregido en WebKit móvil](ux-evidence/menu-webkit-corregido.png).
- [Resumen de validación local](ux-evidence/validation.json).

## Hallazgos y correcciones

Prioridades: P1 bloquea una tarea o una modalidad de acceso; P2 introduce una dificultad o información engañosa; P3 es una mejora menor. La severidad que devuelve axe es su clasificación técnica, independiente de esta prioridad de producto.

### UX-01 · P1 · El menú móvil permite perder el foco

**Reproducción original:** abrir Menú en `/ligas`, con teclado, y pulsar Shift+Tab desde Cerrar. El foco sale del panel aunque siga abierto y marcado como modal. Reproducido en Chromium móvil y WebKit móvil mediante test.

**Impacto:** la navegación del teclado no coincide con la superficie visible; un usuario puede terminar operando controles del fondo.

**Corrección en la rama:** menú con `<dialog>.showModal()`, fondo inerte, ciclo Tab/Shift+Tab, cierre nativo con Escape y restitución del foco y del scroll. Al pasar al ancho de escritorio se cierra el modal para que no quede un bloqueo invisible.

**Verificación:** test `menú móvil: el foco permanece dentro hasta cerrar`, además de los E2E existentes de apertura, Escape, retorno de foco y navegación. También se revisó la captura del menú corregido en Chromium móvil y WebKit móvil.

### UX-02 · P2 · Los enlaces del texto de Ayuda dependen del color

**Reproducción:** entrar en `/ayuda` y revisar los enlaces de contacto y privacidad al final. Axe identifica dos enlaces con `link-in-text-block`; contraste respecto del texto vecino de 2,74:1 en papel y 2,01:1 en nocturna, sin subrayado permanente. No es una medida de contraste contra el fondo.

**Corrección en la rama:** subrayado permanente en los enlaces del cuerpo de `LegalDoc`, compartido por Ayuda, Privacidad y Condiciones.

**Verificación:** escaneo axe de esas tres páginas en ambos temas y los tres navegadores. Los cambios todavía no están desplegados en staging.

### UX-03 · P2 · Cancelar la eliminación pierde el foco en WebKit

**Reproducción:** con usuario local descartable, abrir Eliminar mi cuenta, introducir su email, simular un 503 y pulsar Cancelar. El diálogo se cierra, pero el foco no vuelve al botón de apertura en WebKit.

**Corrección en la rama:** referencia explícita al botón y restitución del foco en `onClose`. Se conserva el email después del error y se permite cancelar.

**Verificación:** test `eliminar cuenta: un fallo conserva el email y permite cancelar`, en los tres navegadores. La respuesta de eliminación se intercepta: este test no borra ninguna cuenta externa.

### UX-04 · P2 · La ayuda del calendario sugiere una recuperación que no funciona

**Problema observado en el código:** Calendario indicaba recuperar un evento borrado con «Reintentar o Sincronizar ahora». Los estados `detached` se excluyen del lote y su acción individual es Agregar. La instrucción mandaba al usuario a una acción que no recupera ese evento.

**Corrección en la rama:** explicar que se respeta la eliminación y dirigir a la ficha del partido → Agregar al calendario. Se mantiene la prevención de recreación automática.

### UX-05 · P2 · La explicación de auto-sync contradice la reconciliación

**Problema observado en código y tests de integración:** Calendario condicionaba la corrección de horarios a auto-sync. El servicio corrige eventos existentes también cuando auto-sync está desactivado; esa opción controla las altas nuevas. Además, «Se agregan en la próxima sync» prometía demasiado para los pendientes de equipos sin auto-sync.

**Corrección en la rama:** aclarar la actualización de eventos ya agregados y describir los pendientes como «Todavía no están en tu calendario».

### UX-06 · P2 · La portada puede prometer un aviso a los 75 minutos

**Evidencia visual:** «con aviso una hora y quince minutos antes» permite interpretar un único aviso 75 minutos antes. Configuración ofrece dos avisos separados.

**Corrección en la rama:** «con dos avisos: uno 1 hora antes y otro 15 minutos antes». No se cambiaron los recordatorios ni sus preferencias.

### UX-07 · P2 · Algunos errores y resultados dinámicos no se anunciaban

**Problema observado en el marcado:** el error al seguir un equipo y los cambios de sincronización individual se insertaban como texto sin región de anuncio.

**Corrección en la rama:** `role="alert"` para los errores y `role="status"` para el estado de sincronización. Los tests exigen el error y el resultado con esos roles, además de comprobar recuperación y bloqueo durante el envío.

**Límite:** los roles se verifican en el DOM. Falta escuchar los anuncios y su orden con VoiceOver/TalkBack.

## Fricciones pendientes de decisión o validación

### UX-08 · P2 · El buscador queda casi fuera de la primera pantalla

En staging, a 375 × 667 CSS px, el campo de búsqueda empieza en `y=656,8` y mide 52px de alto: solo se ven aproximadamente 10px antes de desplazarse. Antes aparecen doce filtros de competencias. La medición y la captura están conservadas en la evidencia.

**Recomendación:** colocar la búsqueda antes de los filtros de liga y mantener el resto como refinamiento. Validar la tarea «Encontrá y seguí a River» con el teléfono sin explicar dónde está el buscador. El cambio de orden no se incluyó en esta rama para mantener separadas las correcciones verificadas de la decisión de jerarquía del producto.

### UX-09 · P2 · La búsqueda se pierde al recargar

En staging se escribió `River`, se recargó `/equipos/buscar` y el campo volvió a vacío. El componente usa estado React sin persistir la consulta en la URL. No se afirma que todos los navegadores pierdan ese estado al volver con Atrás: eso depende, entre otras cosas, de su caché de navegación.

**Recomendación:** conservar consulta y liga en la URL, de modo que recarga, enlaces compartidos y vuelta desde un detalle tengan el mismo contrato. Probar también el estado vacío y Limpiar filtros. Pendiente de implementación.

### UX-10 · P3 · Tamaño de acciones compactas en Hoy

Los tres primeros botones de inicio de sesión medidos en Hoy móvil tienen 40px de alto. Es menor que la meta de comodidad de 44px utilizada para inventariar controles, pero **no prueba por sí solo un incumplimiento WCAG**: deben considerarse el mínimo aplicable, el espacio y las excepciones.

**Recomendación:** comprobar precisión de toque con una mano y subir a 44px si mejora el uso sin deteriorar la lectura de los partidos. Pendiente de prueba física.

## Cobertura de la lista solicitada

«Parcial» significa que existe evidencia acotada y que falta la comprobación indicada; no equivale a aprobación de toda el área.

| Área | Evidencia y estado |
| --- | --- |
| Primera impresión | Revisión de portada y CTA; UX-06 corregido. Falta prueba de comprensión sin ayuda. |
| Jerarquía visual | Comparación de capturas; UX-08 pendiente en búsqueda. |
| Navegación | Menú, enlaces reales, vuelta desde partido con fecha/filtro; UX-01 corregido. |
| Consistencia | Revisión de páginas y ambos temas; UX-04/05 alinean mensajes. Capturas todavía sin referencias aprobadas. |
| Legibilidad | Axe y capturas; UX-02 corregido. Falta texto ampliado al 200% en navegadores reales. |
| Acciones y botones | Progreso, deshabilitado, reintento y consecuencias; UX-10 pendiente de comodidad táctil. |
| Uso con una mano | Pendiente de teléfonos físicos; no inferirlo de emulación. |
| Formularios y teclado | Error de confirmación conserva email; tipo email existente. Falta teclado virtual real y autocompletado. |
| Validaciones y errores | Errores de seguimiento, red y eliminación; conserva entradas y permite reintentar/cancelar. |
| Respuesta a las acciones | Progreso y bloqueo durante sincronización, resultado y anuncios semánticos; UX-07 corregido en DOM. |
| Estados de pantalla | Sin resultados, calendario sin equipos en suite existente, fallo de red y sesión vencida. Falta interrupción real de conectividad y consentimiento rechazado real. |
| Textos y mensajes | UX-04/05/06 corregidos; validar «sync», «auto-sync» e «ICS» con usuarios. |
| Accesibilidad | Axe A/AA, foco de menú/diálogo y roles; falta evaluación con lector real. |
| Adaptación a pantallas | Anchos 320, 375, 768 y 1280 en rutas personales; falta teclado, zoom real y áreas seguras físicas. |
| Convenciones de iOS/Android | Chromium y WebKit emulados; falta Safari/Chrome en equipos físicos y gesto Atrás del sistema. |
| Onboarding y permisos | Exploración sin cuenta e inicio OAuth disponible; consentimiento y vuelta completos pendientes. |
| Eficiencia de recorridos | Buscar, seguir, consultar, sincronizar y volver; UX-08 necesita mejora de jerarquía. |
| Prevención y recuperación | Bloqueo durante envío, error con reintento y cancelación de eliminación; idempotencia respaldada por integración. |
| Continuidad de uso | Preferencias y filtros de Hoy en E2E; UX-09 pendiente y falta cambio de app/interrupción física. |
| Confianza y transparencia | Explicación de permisos y efectos de borrado; UX-04/05/06 corregidos. Falta comprensión con personas. |

## Automatización incorporada

- `npm run test:ux`: configuración independiente con tres navegadores, trece estados de pantalla en dos temas, pruebas de recuperación y reflow. Usa solo el worker local descartable.
- `npm run test:ux:report`: abre `ux-report/`, con capturas y adjuntos axe/layout. El JSON resumido de ejecución está en `ux-artifacts/local-results.json`.
- `npm run audit:ux:staging`: vuelve a recorrer las diez rutas públicas, descubre IDs desde enlaces visibles y guarda `ux-artifacts/staging/report.json` y capturas. Incluye mediciones de búsqueda y controles a 375 × 667. Bloquea requests distintos de GET y no completa login. Su exit code indica si pudo recolectar la evidencia; los hallazgos de producto se consultan en el reporte y no se interpretan como una aprobación.
- `npm run check` y el job `ux` de CI ejecutan la auditoría local. CI descarga el mismo artefacto de aplicación aprobado por los E2E generales.

Las fuentes de Google se permiten en las capturas locales y su estado queda adjunto. Las variaciones de fuentes todavía no se usan como comparación de píxeles. Los datos deportivos locales son fixtures pequeños: no sirven para estimar el rendimiento de una lista con cientos de equipos.

La primera corrida de 87 casos tuvo 79 aprobados, 7 fallidos y 1 no aplicable. Dos fallos reproducían UX-01 y uno UX-03. Los otros cuatro no se declararon defectos de producto: tres usaban una sesión aún válida para simular vencimiento y uno necesitaba esperar la respuesta HTTP del reintento. Se corrigió el diseño de esos tests. Al incorporar las páginas legales se amplió la matriz.

Validación final: `npm run check` terminó con exit code 0 bajo Node 22.23.4. Tipos sin errores (nueve avisos informativos existentes de Drizzle), descubrimiento correcto, cobertura aprobada, build aprobado, E2E generales con 65 aprobados y nueve no aplicables al proyecto, y auditoría UX con 104 aprobados y un no aplicable (menú móvil en escritorio), sin fallidos ni reintentos. Las nuevas configuraciones y tests también pasaron una comprobación TypeScript independiente. La nueva configuración de GitHub Actions se preparó pero no se ejecutó en GitHub desde esta sesión; la validación realizada fue local en Windows.

## Protocolo pendiente con personas y dispositivos

Primera ronda: cinco personas del público objetivo, sin experiencia previa con Fisture. Sesiones de 20–30 minutos. Usar cuentas de prueba en staging y calendarios vacíos de prueba. No indicar rutas ni nombres de botones.

1. Mostrar la portada y pedir que explique para qué sirve y qué haría primero.
2. «Quiero que el próximo partido de mi equipo aparezca en mi calendario». Observar sin guiar.
3. «Buscá el partido de otro día y volvé a donde estabas». Medir conservación de fecha, filtros y posición.
4. «No quiero seguir agregando nuevos partidos automáticamente». Comprobar comprensión de auto-sync y de los eventos existentes.
5. «Quitá un evento y después recuperalo». Comprobar el resultado en el calendario real.
6. «Desconectá el acceso sin borrar tu cuenta». Observar si se entienden las consecuencias.

Registrar por tarea: éxito sin ayuda, tiempo, cantidad de pasos/retrocesos, dudas literales, toques equivocados y evidencia. Si una persona necesita ayuda para la tarea principal, anotar el punto exacto donde la necesitó. Como señal inicial, buscar al menos 4/5 completando la tarea principal sin ayuda; esta muestra no es una certificación estadística.

Dispositivos mínimos: un Android con Chrome y un iPhone con Safari, preferentemente incluyendo un teléfono pequeño. Repetir con texto al 200%, teclado abierto, horizontal, cambio de aplicación, interrupción y restauración de red, y VoiceOver/TalkBack. Para cada plataforma comprobar Google y Microsoft con cuentas de prueba: permiso aceptado/rechazado, callback, horario/zona, dos recordatorios, ausencia de duplicados, reprogramación/cancelación e importación ICS.

## Criterio de salida y despliegue

Antes de producción: suite completa verde, correcciones revisadas y desplegadas en staging, UX-08/09 resueltos o aceptados explícitamente con su impacto, y los recorridos reales de calendario y accesibilidad manual completados. No sustituir estas verificaciones por una nota promedio ni por cero hallazgos de axe.

Cambios de aplicación limitados a semántica de accesibilidad, foco y textos. No hay migraciones, cambios de scopes ni integraciones nuevas. Riesgos a comprobar: disposición del menú nativo y teclado en Safari físico, y claridad de los mensajes corregidos. Para revertir las correcciones de UI se puede revertir su diff sin alterar datos; las pruebas deben seguir señalando las regresiones que se decida restaurar.

No se publicó ni desplegó esta rama durante la auditoría. Las pruebas con personas y las conexiones a cuentas reales no se realizaron en esta sesión.

## Corrección posterior: fila de Próximos partidos (UX-11)

La hora medía 62,125px de texto dentro de una columna fija de 60px, y la acción quedaba en una línea inferior. La fila móvil ahora tiene tres columnas: hora de 22px, equipos y acción. La hora y la acción se centran entre los dos equipos; liga y sede ocupan filas propias. Cada escudo permanece unido a su nombre, que puede pasar a otra línea y usa 17px/22px.

Sin sesión, «Iniciá sesión» tiene borde de 1px, fondo secundario y tamaño aproximado de 86 × 30px. Su destino conserva la ficha del partido para volver después del login. Con sesión, Agregar ocupa la misma columna derecha y mide 30px de alto. Los controles conservan sus estados de progreso, resultado y error. También se subrayó el enlace de inicio de sesión del texto introductorio, detectado por axe como dependiente del color.

Se agregó `/partidos` a la matriz axe y al recorrido de reflow. Los 24 casos de regresión de la fila combinan 320/375px, papel/nocturna, visitante/con sesión y tres configuraciones de navegador. Verifican ancho de la hora, posición de la acción, centrado y nombres largos completos. La prueba reproduce el desborde de la hora antes de la corrección. También se comprobó el cambio de Agregar a En calendario con respuesta simulada.

[Captura sin sesión](ux-evidence/partidos-corregido.png) · [Captura con sesión](ux-evidence/partidos-agregar-corregido.png). La validación de esta corrección es posterior al `npm run check` inicial registrado arriba.

## Validación final para el PR

Se integró `development` hasta `4bb8199` y se ejecutó nuevamente `npm run check` bajo Node 22.23.4: tipos, descubrimiento, cobertura y build aprobados; 1.022 tests unitarios/integración aprobados (un caso existente pendiente), 67 E2E generales aprobados (nueve no aplicables por proyecto) y 134 casos UI/UX aprobados (menú móvil no aplicable en escritorio). No hubo fallidos ni reintentos. El resumen está en `ux-evidence/validation.json`. El CI de GitHub verificará la rama subida; los calendarios reales y la prueba física de dispositivos siguen pendientes de la revisión de staging.

## Ajustes de la revisión (2026-11-06)

- Las acciones de las filas de `/partidos` en móvil (Agregar, Iniciá sesión) pasan de 30 a 40 px de alto, como el resto de los botones compactos de la app; 30 px era poco para tocar con el dedo.
- Los mensajes de la island del partido (motivo del error, solapamiento, error de la acción) ya no quedan apretados en la columna de 110 px del botón: en móvil la island se integra a la grilla de la fila, el estado corto queda debajo del botón y los mensajes largos ocupan el ancho de la columna de los equipos.
