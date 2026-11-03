# Competencias y sincronización de partidos

## Qué se sincroniza

Fuente única: **ESPN** (API pública, sin API key). Configuración en
`src/lib/data-providers/types.ts` (`LEAGUES_CONFIG`). El `externalId` de cada competencia es el slug de ESPN.

Hay dos clases de competencias (docs/22):

- **Destacadas**: se listan en `/ligas`, en los filtros, en la búsqueda, el sitemap y `llms.txt`, con todos sus participantes.
- **No destacadas**: no se listan. Solo se guardan los partidos en los que juega algún equipo de una competencia
  destacada (y su rival), y aparecen en el fixture de ese equipo, en `/hoy`, `/partidos`, el `.ics` y el calendario.

| Clase | Competencias |
| --- | --- |
| Ligas (destacadas) | Premier League `eng.1`, La Liga `esp.1`, Serie A `ita.1`, Bundesliga `ger.1`, Ligue 1 `fra.1`, Liga Profesional `arg.1`, Brasileirão `bra.1` |
| Copas destacadas | Champions `uefa.champions`, Europa League `uefa.europa`, Conference `uefa.europa.conf`, Libertadores `conmebol.libertadores`, Sudamericana `conmebol.sudamericana` |
| Internacionales no destacadas | Clasificatorias UEFA (`*_qual`), Supercopa de la UEFA, Recopa, Mundial de Clubes `fifa.cwc`, Copa Intercontinental |
| Copas nacionales (no destacadas) | FA Cup, Carabao Cup, Community Shield, Copa del Rey, Supercopa de España, Coppa Italia, Supercopa de Italia, DFB-Pokal, Supercopa de Alemania, promociones de Bundesliga y Ligue 1, Coupe de France, Trophée des Champions, Copa Argentina, Supercopa Argentina, Supercopa Internacional, Trofeo de Campeones, Copa do Brasil, Supercopa do Brasil, Copa do Nordeste y estaduales (Paulista, Carioca, Mineiro, Gaúcho) |

Para agregar una competencia: sumar una entrada a `LEAGUES_CONFIG` (slug de ESPN) con `liga`, `copaDestacada` o
`copa`. El orden importa: ligas, después copas destacadas y al final el resto, para que cada equipo quede asociado
a su liga de origen y las copas no destacadas ya conozcan a los equipos. Un equipo que entró por una copa (sin
país) adopta su liga cuando esa liga se sincroniza.

## Cómo funciona

1. `getFixture(slug)` pide `scoreboard?dates={año}` (año calendario completo) para el año en curso y el
   contiguo que corresponda a la temporada. ESPN devuelve equipos y partidos en la misma respuesta.
2. Se descartan los equipos placeholder de llaves sin definir (`TBD Home`, `Winner …`).
3. Se calcula la ronda en español: `Fecha N`, `Fase de liga · Fecha N`, `Octavos de final · Ida`,
   `Clausura · Fecha N`, etc. ESPN no entrega el número de fecha: se deduce contando los partidos de cada equipo.
4. `sync.ts` hace upsert en lotes y **solo escribe lo que cambió**. Un segundo sync inmediato no modifica nada.

Qué se guarda: la **temporada en curso completa** (partidos jugados con su resultado y los que faltan) y todo
lo futuro, con estado (`scheduled | live | finished | postponed | cancelled`), sede y ronda. Las temporadas
anteriores no se guardan.

## Modelo de datos

- `teams.external_id` es único y global (`espn:{id}`): un equipo que juega la liga y una copa es una sola fila.
- `teams.league_id` es la **liga de origen** (la primera competencia en que se cargó).
- `league_teams` (migración `0003`) indica en qué competencias juega cada equipo en la temporada en curso.
  Las pantallas de ligas y búsqueda usan esta tabla, así la Champions lista sus 36 participantes.
- Las competencias que ya no están en la configuración se marcan `is_active = false` en cada sync completo.

## Operación

```bash
# Verificar el sync contra una D1 efímera (no toca ninguna base real)
npm run sync:check                    # todas las competencias
npm run sync:check -- eng.1 arg.1     # solo algunas
SYNC_TWICE=1 npm run sync:check       # además comprueba que una segunda pasada no cambia nada
```

Producción: aplicar la migración `0003` con `wrangler d1 execute` (no con `migrations apply`: la `0001` borra
tablas, es solo para desarrollo).

```bash
npx wrangler d1 execute fisture-db --remote --file=drizzle/migrations/0003_league_teams.sql
```

- Sync completo: cron diario (`functions/scheduled.ts`) o `POST /api/admin/sync` con `Authorization: Bearer $ADMIN_SECRET`.
  Hay que enviar `Content-Type: application/json` (cuerpo `{}`): sin él, la protección CSRF de Astro responde 403.
- Una sola competencia: `POST /api/admin/sync` con `{"leagueId": "eng.1"}`.
- Por lotes (lo que usa `sync-cron.yml`): `POST /api/admin/sync` con `{"lote": 0}`; la respuesta trae
  `siguienteLote` (`null` en el último, que además desactiva las competencias que salieron de la configuración).
  Workers Free admite 50 subrequests por invocación y un sync completo de ~43 competencias no entra: cada lote
  son 5 competencias (docs/22 D4).

## Verificación de punta a punta

El build se ejecuta en el runtime real (workerd) con `wrangler pages dev ./dist`. Para que arranque hicieron
falta dos ajustes en `astro.config.mjs`: `imageService: "passthrough"` (Workers no ejecuta `sharp`) y el alias
`react-dom/server` → `react-dom/server.edge` (React 19 usa `MessageChannel`, que Workers no tiene).

Resultado verificado: sync completo por `/api/admin/sync` (13 competencias, 15 s, 0 errores), búsqueda, seguir
equipos de ligas y copas, `/api/partidos`, descarga `.ics`, páginas con sesión y sin sesión, y 211 equipos
seguidos a la vez (antes fallaba pasados ~48 por el límite de parámetros de D1).

## Limitaciones conocidas

- ESPN es una API no oficial y sin contrato: puede cambiar sin aviso. Los providers de `football-data.org` y
  Promiedos siguen en el código (`football-data.ts`, `promiedos.ts`) como alternativa, pero no están en `LEAGUES_CONFIG`.
- Las llaves se completan cuando ESPN publica los cruces; hasta entonces esos partidos no existen.
- Dos clubes distintos pueden compartir nombre (ej.: Liverpool de Inglaterra y de Uruguay): se distinguen por su ID.
