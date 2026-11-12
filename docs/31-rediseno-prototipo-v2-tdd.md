# TDD: Rediseño de pantallas según el prototipo v2

Fecha: 12 de noviembre de 2026. Origen: prototipo «Fisture Prototipo» de Claude Design (fuente: `Fisture Rediseno v2.dc.html`, 14 pantallas, desktop y mobile, temas papel y nocturna). Sistema visual: Tribuna 90, el mismo que ya usa la app (`src/styles/tribuna90.css`).

## 1. Contexto y problema

La app ya usa Tribuna 90. El prototipo no cambia la identidad visual: cambia **cómo se recorre la app y cómo se agregan partidos**. Las notas del prototipo («Qué cambia en…») resumen los cambios por pantalla. Este documento los traduce a trabajo sobre el código actual.

Lo que hoy falta o se hace distinto:

- **Navegación.** La cabecera tiene volanta, número y fecha, y en mobile hay un menú desplegable (`MenuMovil.astro`). El prototipo pide una cabecera compacta y fija, buscador en la cabecera en desktop y, en mobile, una barra inferior: Hoy, Partidos, **Buscar al centro** (botón amarillo elevado), Ligas y Calendario. Cuenta pasa al avatar de la cabecera (variante «D» del prototipo).
- **Una sola fila de partido y un solo estilo de acción.** Hoy conviven `HoyMovil`, filas de `partidos/index`, `ligas/[id]` y `equipos/[id]`, cada una con su markup y su botón.
- **Flujos nuevos para agregar partidos** (notas de Hoy):
  - **A**: sin sesión se eligen partidos y se agregan después del login, sin perder la selección.
  - **B**: la estrella de cada partido permite agregar solo ese o seguir a uno de los equipos y sumar sus próximos partidos.
  - **C**: el botón muestra el estado: Agregar, Agregando…, Agendado, Actualizar, Reintentar. Una línea debajo explica el estado, incluida la hora anterior y la nueva cuando cambió el horario.
  - **D**: un día sin partidos lleva al próximo día con actividad o al próximo partido de tus equipos.
  - **E**: el aviso de superposición aparece **antes** de agregar. Hoy aparece después (`overlapWarnings` en `sync-service.ts`).
- **Onboarding** de 3 pasos después del primer login: equipos, avisos y primera sincronización. No existe.
- **Ajustes por pantalla**: Portada, Login, Partidos, Ficha de partido, Ligas, Liga, Equipo, Buscar, Calendario, Cuenta (hoy `/configuracion`), Ayuda y 404. Detalle en §3.3.

### 1.1 Lo que ya existe y se reutiliza

| Necesidad del prototipo | Ya existe |
|---|---|
| Avisos 60/15 y tema | `user_preferences.reminder_60`, `reminder_15`, `theme` + `PATCH /api/preferencias` |
| Auto-sync por equipo | `user_teams.auto_sync` + `PATCH /api/equipos/[id]` |
| Volver a la pantalla después del login | `?next=` con `safeNext` en `login.astro` y el callback OAuth |
| Hora anterior en «Horario actualizado» | `calendar_syncs.synced_date_time` |
| Agregar varios partidos | `POST /api/calendario/sync` con `matchIds` (tope `MAX_PARTIDOS_POR_REQUEST` = 5) |
| Superposición con otros eventos | `client.overlaps(...)` en los clientes de Google y Microsoft |
| Fixture de liga (20 partidos en 30 días), próximo partido del equipo, panel de datos de la ficha, texto de 404 | PR #78 |
| Buscador primero y estado en la URL | `docs/28` |
| Eliminar cuenta | `EliminarCuenta.tsx` + `DELETE /api/cuenta` |

## 2. Objetivos y no objetivos

**Objetivos**

- Las 14 pantallas del prototipo implementadas en desktop y mobile, en papel y nocturna.
- Un componente de fila de partido y uno de acción de calendario, usados en todas las listas.
- Flujos A a E y onboarding funcionando contra la API real.
- Sin regresiones en SEO (contenido indexable del PR #78), accesibilidad (`docs/27`) ni en el presupuesto de subrequests de Workers Free.

**No objetivos**

- Cambiar el sistema visual, la paleta clara o las fuentes. Del archivo «Paletas Dark Mode» se toma solo la paleta Pizarra (decisión 15); Tinta, Estadio, Cancha y Vino se descartan.
- Las otras variantes de menú mobile del prototipo (A, B, C, E). Se implementa solo la D.
- Resultados en vivo. «En juego» se deriva de `matches.status` y del horario; no se agrega una fuente de datos en tiempo real.
- Cambiar el sync de ligas, la reconciliación de calendarios o el modelo de `calendar_syncs`.
- Mover los avisos a un valor libre (siguen siendo 60 y 15 minutos, cada uno activable).

## 3. Decisiones

### 3.1 Navegación y estructura

1. **Cabecera compacta y fija** (`Cabecera.astro`). Desktop: FISTURE, secciones, buscador que lleva a `/equipos/buscar` y avatar o «Iniciar sesión». Mobile: FISTURE, lupa (sin sesión) o avatar (con sesión). La volanta grande queda solo en la portada. *Descartado:* conservar número y fecha de edición; ocupan altura en todas las pantallas y no ayudan a la tarea.
2. **Barra inferior en mobile** (nuevo `BarraInferior.astro`, reemplaza `MenuMovil.astro`). Cinco destinos con enlaces reales (`<a>`, sin JavaScript), `aria-current` en el activo, `padding-bottom: env(safe-area-inset-bottom)`. Buscar va al centro como botón amarillo con `--sombra-registro`. *Descartado:* menú hamburguesa; esconde las secciones y ya causó el problema de foco UX-01.
3. **Cuenta = `/cuenta`.** `/configuracion` redirige con 301 a `/cuenta`, para no romper enlaces ni marcadores.
4. **Sin cambios de URLs públicas** salvo `/cuenta` y la nueva `/bienvenida` (onboarding). Las dos van con `noindex`.

### 3.2 Fila de partido y acción de calendario

5. **`FilaPartido.astro`** (estático, 0 JS): hora en Anton, competencia en rojo, local y visitante con sigla, sede. Enlaza a la ficha. Si el partido terminó, muestra el resultado y **no tiene acción**.
6. **`AccionPartido.tsx`** (island, `client:visible`): la única forma de agregar un partido. Reemplaza `SincronizarPartido` y la lógica duplicada de `HoyMovil`. Estados:

   | Estado | Origen | Botón | Línea debajo |
   |---|---|---|---|
   | sin evento | sin fila en `calendar_syncs` | Agregar (primario) | — |
   | agregando | request en curso | Agregando… (deshabilitado) | `aria-live` |
   | agendado | `synced` | Agendado | «En tu calendario» |
   | actualizado | `synced` y la hora cambió en el último sync | Agendado | «Horario actualizado: antes 21:00, ahora 19:15» |
   | por actualizar | `needs_update` | Actualizar (tinta) | Motivo (hora, sede, postergado) |
   | error | `failed` | Reintentar (tinta) | Mensaje de `MENSAJES_CORTE` |
   | quitado | `detached` | Agregar | «Lo borraste de tu calendario» |

   La leyenda de estados se abre con un botón «¿Qué significa?» (un `<details>`, sin JavaScript extra).

   «Actualizado» requiere guardar la hora anterior **al aplicar** la actualización. Hoy `synced_date_time` se pisa al sincronizar. Decisión: nueva columna `calendar_syncs.previous_date_time`, escrita por `syncMatches` y la reconciliación cuando cambia la hora, y mostrada durante 7 días. *Descartado:* calcularla desde `sync_runs`; no guarda datos por partido.

7. **Estrella (Flujo B)**: menú con «Agregar solo este partido» y «Seguir a X», una opción por equipo. Seguir hace `POST /api/equipos` y después agrega los próximos partidos del equipo **en lotes de 5** (el tope por request). La opción dice cuántos son («Agregamos este y sus próximos 6 partidos»). El conteo sale del servidor, en el mismo HTML de la fila.

### 3.3 Flujos nuevos

8. **Selección sin sesión (Flujo A).** Sin sesión, el botón dice «Elegir». La selección se guarda en `sessionStorage` (`fisture:seleccion`, solo ids de partido, máximo 30). Al tocar «Agregar N al ingresar», se va a `/login?next=/hoy&accion=agregar`. Cuando vuelve con sesión, `AccionPartido` encuentra la selección, la agrega en lotes de 5 y la borra. Si `sessionStorage` no está disponible, el botón vuelve al comportamiento actual (ir al login). *Descartado:* guardar la selección en el servidor antes del login; obliga a crear estado anónimo en D1 solo para esto.
9. **Login con contexto.** `login.astro` lee `accion` (`seguir`, `agregar`; lista cerrada) y muestra un `Recuadro` amarillo con el motivo («Para seguir a River Plate, ingresá con tu calendario»). El nombre del equipo se busca en D1 por id, nunca se toma del query string.
10. **Día sin partidos (Flujo D).** `/hoy?dia=` sin partidos muestra un bloque con el próximo día con actividad y, con sesión, el próximo partido de tus equipos. Una consulta acotada (`LIMIT 1`, índice existente de `matches` por fecha).
11. **Superposición antes de agregar (Flujo E).** Nuevo `GET /api/calendario/superposicion?matchId=`: llama a `client.overlaps` y devuelve `{ superpone: boolean, cantidad: number, eventos?: { titulo, inicio, fin }[] }`. Los títulos se devuelven solo al dueño de la sesión y nunca se loguean ni se guardan (regla de `docs/11`). `AccionPartido` lo consulta al tocar Agregar. Si hay superposición, muestra un aviso con «Agregar igual» y «Cancelar». Si la consulta falla o tarda más de 2 s, agrega sin avisar: el aviso nunca bloquea el alta. Costo: 1 request al calendario + renovación eventual del token, dentro del presupuesto. Rate limit propio (`calendar_overlap`). «Agregar visibles» y el Flujo A **no** consultan superposición (evita N llamadas); el aviso posterior que ya existe sigue para esos casos.
12. **Agregar visibles.** Cuenta solo los partidos elegibles (no terminados y sin evento). Pide confirmación con el número exacto y agrega en lotes de 5, con progreso visible. Reemplaza `SincronizarTodo`.
13. **Onboarding** (`/bienvenida`, 3 pasos). Paso 1: equipos (buscador + populares; si el usuario llegó desde «Seguir», ese equipo ya viene marcado). Paso 2: avisos 60/15 y auto-sync por defecto. Paso 3: primera sincronización de los partidos de los próximos 14 días de esos equipos, en lotes (decidido el 12/11). Los posteriores llegan con auto-sync. «Ahora no» siempre visible. En mobile, la barra de Continuar queda fija abajo.
    - Se muestra una sola vez: nueva columna `users.onboarded_at` (timestamp, nullable). El callback OAuth redirige a `/bienvenida` si es `NULL` y no hay un `next` de una acción concreta. Terminar o «Ahora no» la completa.
    - Los usuarios existentes **no** ven el onboarding: la migración rellena `onboarded_at` con `created_at`.
14. **Auto-sync por defecto.** Nueva columna `user_preferences.auto_sync_default` (boolean, default `true`). Se usa como valor inicial de `user_teams.auto_sync` al seguir un equipo. Hoy ese default está fijo en el esquema.

### 3.4 Ajustes por pantalla

| Pantalla | Ruta | Cambios |
|---|---|---|
| Portada | `/` | Evento de ejemplo armado en HTML dentro de un día de calendario, con `Sello` «Gratis». «Hoy se juega» con `FilaPartido` y acción. Se conservan «Qué es Fisture» y los permisos como texto indexable. Un solo CTA, arriba y al cierre. |
| Login | `/login` | Recuadro de contexto (decisión 9). Proveedores como opciones de 76 px; el permiso se explica antes de elegir. |
| Hoy | `/hoy` | Con sesión, barra «Tus equipos» primero y bajada con quién juega. Filtros combinables: Mis equipos, Agregados y liga. Flujos A a E. |
| Partidos | `/partidos` | Agrupado por día con «Hoy» y «Mañana». Sin sesión: 14 días de todas las ligas y atajo «Ver solo mis equipos» (lleva al login). |
| Ficha | `/partidos/[id]` | Vista previa del evento tal como queda en el calendario, con los avisos de la cuenta. La acción principal va junto a la vista previa; «Quitar» queda secundaria. |
| Ligas | `/ligas` | Buscador primero. Cada liga muestra partidos de hoy y, con sesión, cuántos equipos seguís. |
| Liga | `/ligas/[id]` | Pestañas Fixture (default) y Equipos, como enlaces (`?tab=equipos`) para que funcionen sin JS. Seguir en cada tarjeta de equipo. |
| Equipo | `/equipos/[id]` | Próximo partido destacado con su acción. Seguir y auto-sync juntos, con una línea que explica cada uno. `.ics` pasa a secundaria. |
| Buscar | `/equipos/buscar` | Seguir desde el resultado, sin entrar al equipo. El resto ya está (`docs/28`). |
| Calendario | `/calendario` | Con sesión: contadores (agendados, por actualizar, con error), «Para revisar» y auto-sync por equipo en un mismo lugar. Sin sesión: se conserva el contenido del PR #78. |
| Cuenta | `/cuenta` | Avisos, auto-sync por defecto y tema se guardan al tocar (`PATCH`, con estado visible). Eliminar pide escribir el email exacto antes de habilitar el botón. |
| Ayuda | `/ayuda` | Preguntas en `<details>` (acordeón sin JS). Enlaces subrayados (UX-02). Textos del prototipo para auto-sync y eventos borrados, alineados con UX-04 y UX-05. |
| 404 | `/404` | Sin cambios de texto. Se suman las cuatro secciones como salida. |

### 3.5 Tema oscuro: paleta Pizarra

15. **Pizarra reemplaza los colores de nocturna** (paleta 1e del prototipo: gris azulado frío, sombra de imprenta celeste). Se cambian solo los valores de `[data-theme="nocturna"]` en `tribuna90.css`. El nombre del tema no cambia (`'nocturna'` en `user_preferences.theme`, en la API y en el script de `prefers-color-scheme`), así que no hay migración de datos. En Cuenta, la opción pasa a llamarse «Pizarra».

    | Token | Valor |
    |---|---|
    | `--papel` / `--papel-2` | `#14181c` / `#1e242a` |
    | `--tinta` / `--tinta-suave` / `--linea` | `#eceff1` / `#a3acb4` / `#44505a` |
    | `--rojo` / `--rojo-profundo` | `#e5432f` / `#9e1a10` |
    | `--amarillo` / `--on-amarillo` | `#f2d43b` / `#14181c` |
    | `--celeste` / `--on-celeste` / `--celeste-claro` | `#4fc3d6` / `#0a0d10` / `#142c33` |
    | `--barra-tinta` / `--crema-sobre-oscuro` / `--crema` | `#0a0d10` / `#eceff1` / `#262a24` |
    | `--sombra-registro` | `4px 4px 0 #4fc3d6` |

    Se conserva la separación actual entre `--rojo` (texto) y `--rojo-fondo` (superficies). El prototipo pone blanco sobre `#e5432f` (≈ 3,9:1), que no llega a AA para texto chico. `--rojo-fondo` arranca en `#e5432f` y se oscurece lo mínimo necesario hasta que axe no marque contraste en la cabecera, las barras y el botón primario. `--azul` (solo en CabezalSeccion) toma `#4fc3d6`, el celeste de la paleta, porque Pizarra no define azul.

### 3.6 Contenido

Los textos salen del prototipo: voseo, titulares en mayúsculas, sin emoji, flecha → solo si lleva a otra página. Los datos del prototipo (equipos, «Hola, Lucía», horarios) son de ejemplo y **no** se copian: todo sale de D1.

## 4. Cambios de datos (migración `0015_rediseno_onboarding.sql`)

```sql
ALTER TABLE users ADD COLUMN onboarded_at INTEGER;
UPDATE users SET onboarded_at = created_at;
ALTER TABLE user_preferences ADD COLUMN auto_sync_default INTEGER NOT NULL DEFAULT 1;
ALTER TABLE calendar_syncs ADD COLUMN previous_date_time INTEGER;
```

Son tres columnas nuevas, todas opcionales o con default. No hay borrados ni renombres, así que el código anterior sigue funcionando con la base migrada (rollback del código sin rollback de datos).

## 5. Estrategia de tests (test primero: rojo, verde, refactor)

**Unit / integración (Vitest, D1 efímera)**

- `estadoAccion(sync, ahora)`: tabla de la decisión 6, incluido «actualizado» solo dentro de los 7 días.
- `syncMatches` y la reconciliación escriben `previous_date_time` cuando cambia la hora y no lo tocan si no cambió.
- `GET /api/calendario/superposicion`: 401 sin sesión; sin superposición; con superposición; error del proveedor → `superpone: false` con 200; títulos ausentes en los logs (spy sobre el logger); rate limit aplicado.
- Callback OAuth: usuario nuevo sin `next` → `/bienvenida`; con `next` de acción → `next`; usuario con `onboarded_at` → nunca `/bienvenida`.
- Migración 0015: los usuarios existentes quedan con `onboarded_at` no nulo.
- `PATCH /api/preferencias` acepta `autoSyncDefault`; `POST /api/equipos` lo usa como default.
- `/configuracion` → 301 a `/cuenta`.
- Login: `accion` desconocida se ignora; el nombre del equipo sale de D1.

**E2E (Playwright, escritorio y mobile)**

- Barra inferior: 5 destinos, activo con `aria-current`, sin desborde a 320 px, no tapa contenido (último elemento visible al final del scroll).
- Flujo A: sin sesión elegir 2 partidos → login (sesión de prueba) → vuelven agregados y la selección queda vacía.
- Flujo B: estrella → seguir → el equipo aparece en «Tus equipos» y sus partidos quedan agendados.
- Flujo C: cada estado de la tabla renderiza su botón y su línea (fixture de `calendar_syncs`).
- Flujo D: día sin partidos muestra el próximo con actividad.
- Flujo E: con superposición simulada aparece el aviso; «Cancelar» no agrega; con error del endpoint agrega igual.
- Onboarding: 3 pasos, «Ahora no» en cada uno, no vuelve a aparecer.
- Agregar visibles: confirma con el número exacto y agrega 12 partidos en 3 lotes.
- Cuenta: eliminar deshabilitado hasta escribir el email exacto.
- SEO: las aserciones de `seo-head.spec.ts` y del contenido sin JS del PR #78 siguen en verde. `/cuenta` y `/bienvenida` con `noindex`.
- Accesibilidad: axe sin violaciones nuevas en las 14 pantallas, ambos temas (`tests/e2e/ux/audit.spec.ts`).

**Visual**: capturas de referencia por pantalla (desktop 1280, mobile 375, papel y nocturna), comparadas con el prototipo a ojo en la revisión del PR.

## 6. Plan de implementación

Cada paso es un PR a `development` con su CI en verde. El orden permite publicar en staging de a partes.

1. **Base** — migración 0015, `previous_date_time` en sync y reconciliación, `autoSyncDefault` en preferencias y equipos. Sin cambios visibles.
2. **Navegación y tema** — cabecera compacta, `BarraInferior`, `/cuenta` con redirect desde `/configuracion`, paleta Pizarra.
3. **Fila y acción** — `FilaPartido` y `AccionPartido` con la tabla de estados (Flujo C). Se aplican en Hoy, Partidos, Liga, Equipo y Ficha. Se retiran `SincronizarPartido`, `SincronizarTodo` y la lógica de `HoyMovil`.
4. **Hoy completo** — filtros, Agregar visibles, Flujo D, estrella (Flujo B).
5. **Superposición previa** — endpoint y aviso (Flujo E).
6. **Sin sesión** — selección (Flujo A) y login con contexto.
7. **Onboarding** — `/bienvenida` y redirect del callback.
8. **Pantallas restantes** — Portada, Ligas, Liga (pestañas), Equipo, Buscar, Calendario, Cuenta, Ayuda y 404.
9. **Cierre** — capturas, `npm run check`, notas de implementación de este documento.

## 7. Despliegue y rollback

- **Migración 0015**: se aplica sola en el release (`deploy.yml`). Es aditiva. Rollback del código sin revertir la migración.
- **Sin variables de entorno nuevas.** Rate limit nuevo `calendar_overlap` en `lib/rate-limit/policies.ts`.
- **Staging**: cada paso se revisa en `development.fisture.pages.dev` antes del siguiente. La cuota de lecturas D1 se comparte con staging: los pasos 4 y 8 agregan consultas por página y hay que medirlas (`docs/30`).
- **Release**: uno solo, cuando estén los pasos 1 a 9 (decidido el 12/11). Hasta entonces todo se ve únicamente en staging.
- **Google OAuth**: no se cambian scopes ni el consent screen. La consulta de superposición usa el permiso de calendario que ya tenemos. Si hiciera falta un scope nuevo, habría que reverificar la app.

## 8. Riesgos

- **Presupuesto de subrequests.** La superposición previa suma una llamada por alta individual. Mitigación: solo en altas individuales, con timeout, y nunca bloquea.
- **Lecturas D1.** Contadores de Ligas, «Tus equipos» en Hoy y el próximo día con actividad agregan consultas. Mitigación: consultas acotadas con índice y medición en staging antes del release.
- **SEO.** Cambiar la cabecera y la portada puede mover títulos y enlaces internos. Mitigación: los tests de `seo-head` y del contenido del PR #78 no se tocan; tienen que seguir pasando.
- **Tamaño del cambio.** Son 14 pantallas. Mitigación: PRs por paso (§6) y staging entre pasos.
- **`sessionStorage` en navegadores in-app** (Instagram, etc.) puede perderse al ir al proveedor OAuth. Mitigación: degradación al comportamiento actual (decisión 8).

## 9. Decisiones

Revisadas el 12/11:

1. Un solo release (§7).
2. Días que se muestra «Horario actualizado»: **pendiente**. Se propone 7.
3. Onboarding: partidos de los próximos 14 días.
4. Tema oscuro: solo la paleta Pizarra (§3.5).

## 10. Notas de implementación

_(Se completa al terminar, con los desvíos respecto de este diseño.)_
