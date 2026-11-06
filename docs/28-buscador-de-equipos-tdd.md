# TDD: Buscador de equipos primero y con estado en la URL

Fecha: 6 de noviembre de 2026. Origen: hallazgos UX-08 y UX-09 de `docs/27-auditoria-ui-ux.md`, reverificados en staging el 6/11 (M-02 y M-03 de la auditoría mobile).

## 1. Contexto y problema

En `/equipos/buscar` el campo de búsqueda va después de los chips de competencias. A 375 × 667 px, el campo empieza en `y=657` y casi no se ve sin desplazarse. La tarea principal de la pantalla («encontrá y seguí a tu equipo») depende de un control que no está en la primera pantalla.

La consulta y la liga elegida viven solo en el estado de React. Al recargar, compartir el enlace o volver desde otra pantalla, el buscador queda vacío.

## 2. Objetivos y no objetivos

**Objetivos**

- El campo de búsqueda es lo primero que se ve después del título, en todas las anchuras.
- En móvil, los chips de competencias no empujan la lista hacia abajo: ocupan una sola fila con desplazamiento horizontal.
- La consulta (`q`) y la competencia (`liga`) se reflejan en la URL. Recargar, compartir el enlace o volver con Atrás restituye ambos.
- El HTML del servidor ya trae el estado de la URL, sin esperar a la hidratación.

**No objetivos**

- Cambiar el filtrado (sigue siendo en el cliente, sobre la lista completa).
- Llevar el estado a la URL en el filtro de equipos de `/ligas/[id]`: esa pantalla no tiene chips y su lista es corta.
- Paginación o búsqueda en el servidor.
- Cambiar la altura de los chips (UX-10 queda pendiente de prueba en teléfonos reales).

## 3. Decisiones

1. **Orden: buscador, después chips.** Los chips pasan a ser un refinamiento. Alternativa descartada: ocultar los chips detrás de un botón «Filtrar»; agrega un toque y esconde una opción que hoy se usa para recorrer ligas.
2. **Chips en una fila desplazable en ≤ 640 px.** Mismo patrón que la tira de filtros de Hoy (`.hm-chips`). Con 12 competencias, una grilla ocupaba seis filas a 320 px. Alternativa descartada: un `<select>`; pierde la vista de las opciones y el estilo de la app.
3. **`history.replaceState`, no `pushState`.** Cada letra no debe crear una entrada en el historial: Atrás tiene que salir de la pantalla, no deshacer la búsqueda letra por letra. La entrada actual queda con el último estado, así que volver desde la ficha de un equipo lo restituye.
4. **Estado inicial desde el servidor.** `buscar.astro` lee `q` y `liga` de `Astro.url` y se los pasa a la island. Una `liga` desconocida se ignora. La consulta se recorta a 80 caracteres.
5. **Sincronización opcional (`sincronizarUrl`).** Solo la activa `/equipos/buscar`. Así `/ligas/[id]` no escribe parámetros que su servidor no lee.
6. **«Limpiar filtros» borra también los parámetros de la URL.**

## 4. Estrategia de tests

Primero en rojo, en `tests/e2e/ux/audit.spec.ts` (tres navegadores):

- **Primera pantalla:** a 375 × 667 el buscador queda completo dentro del viewport sin desplazar, y antes que los chips en el orden del documento.
- **Chips en móvil:** a 320 px los chips ocupan una sola fila y la página no desborda horizontalmente.
- **URL:** escribir «River» y elegir una liga actualiza `?q=River&liga=…`. Al recargar, el campo, el chip activo y los resultados se mantienen. Navegar a otra página y volver con Atrás también.
- **HTML del servidor:** pedir `/equipos/buscar?q=River` sin JavaScript devuelve el campo con `value="River"`.
- **Entradas inválidas:** `?liga=inexistente` muestra todas las ligas, sin error.
- **Limpiar filtros** deja la URL sin `q` ni `liga`.

Los tests existentes de búsqueda (fallo al seguir, sin resultados) siguen pasando sin cambios.

## 5. Plan de implementación

1. Tests en rojo.
2. `FiltroEquipos`: props `consultaInicial` y `sincronizarUrl`. Reordenar buscador y chips. Efecto que escribe la URL con `replaceState`.
3. `buscar.astro`: leer y validar `q` y `liga`; pasarlos a la island.
4. CSS: fila desplazable de chips en ≤ 640 px.
5. Verde, `npm run check`, y completar las notas de implementación.

## 6. Despliegue y rollback

Sin migraciones, variables de entorno ni cambios de API. Se despliega con el flujo normal (`development` → staging → release). Rollback: revertir el commit; los enlaces con `?q=` siguen funcionando, solo que se ignoran los parámetros.

## 7. Riesgos

- **El buscador pegajoso tapa el chip enfocado al navegar con teclado.** La barra pegajosa ya existía; los chips ahora quedan debajo de ella. Mitigación: `scroll-margin-top` en los chips.
- **Desplazamiento horizontal poco evidente.** Una fila de chips cortada por el borde puede no indicar que hay más. Se deja el último chip visible a medias, como en Hoy. Validar en la prueba con personas.
- **Datos en la URL.** La consulta es el nombre de un equipo, no un dato personal. No se loguea.

## 8. Notas de implementación

- **Aprobación:** el TDD se escribió y se implementó en el mismo PR, a pedido explícito de hacer los dos PRs de la auditoría sin esperar la revisión intermedia. Si la revisión cambia alguna decisión, se ajusta en este mismo PR.
- **Demora antes de `replaceState`:** no estaba en el diseño. Se escribe la URL 250 ms después de la última tecla porque Safari rechaza más de 100 llamadas a `replaceState` cada 30 segundos. Si igual falla, se ignora: la búsqueda sigue funcionando y solo deja de conservarse al recargar.
- **La consulta se guarda recortada** (sin espacios al principio ni al final); en el campo queda como se escribió.
- **Tests:** cuatro casos nuevos en `tests/e2e/ux/audit.spec.ts`. Se comprobó que fallan antes del cambio (buscador después de los chips, URL sin `q`, HTML sin `value`) y pasan después, en Chromium de escritorio, Chromium con Pixel 7 y WebKit con iPhone 13. Los datos locales tienen solo dos competencias; la fila desplazable con las doce de staging hay que mirarla después del deploy.
