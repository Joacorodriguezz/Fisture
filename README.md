# Fisture

**Los partidos de tu equipo, directo en tu calendario.**

Fisture es una app web gratuita que agrega el fixture de tus equipos de fútbol a Google Calendar u Outlook. Elegís tus equipos una vez y cada partido aparece como evento, con fecha, hora argentina y estadio. Si un partido se reprograma o se suspende, el evento se actualiza solo.

Sitio en producción: https://fisture.com

## Qué hace

- **Sincronización automática:** los eventos se actualizan una vez por día y se corrigen cuando cambia un horario.
- **Recordatorios:** avisos 1 hora y 15 minutos antes de cada partido.
- **Competencias:** Liga Profesional, Brasileirão, Premier League, La Liga, Serie A, Bundesliga, Ligue 1, Libertadores, Champions League y copas nacionales.
- **Sin cuenta para explorar:** se pueden ver los partidos de hoy, los próximos, el calendario de cada liga y buscar equipos.
- **Permisos mínimos:** solo edita los eventos que crea; no lee correo ni contactos, y el acceso se puede revocar cuando quieras.

## Stack

| Capa | Tecnología |
|------|------------|
| Frontend | Astro 5 + React 19 (islands) + Tailwind CSS |
| Runtime y hosting | Cloudflare Pages + Workers |
| Base de datos | Cloudflare D1 (SQLite) con Drizzle ORM |
| Autenticación | OAuth con Arctic (Google y Microsoft) |
| Tests | Vitest, Playwright y axe-core (accesibilidad) |

La arquitectura completa está en [docs/01-arquitectura.md](docs/01-arquitectura.md).

## Cómo correrlo en local

1. Instalá las dependencias con `npm install`.
2. Copiá `.env.example` a `.env` y completá las credenciales (Cloudflare, OAuth, clave de cifrado de tokens, API de fútbol).
3. Aplicá las migraciones locales con `npm run db:migrate:local`.
4. Levantá el servidor con `npm run dev`.

Para probar el build sobre el runtime de Cloudflare: `npm run build` y después `npm run cf:dev`.

## Calidad y tests

| Comando | Qué hace |
|---------|----------|
| `npm test` | Tests unitarios y de integración |
| `npm run test:coverage` | Cobertura |
| `npm run test:e2e` | Tests end-to-end con Playwright |
| `npm run test:ux` | Auditoría de UX y accesibilidad |
| `npm run typecheck` | Chequeo de tipos con `astro check` |
| `npm run check` | Todo lo anterior, más el build |

El proyecto se desarrolla con TDD: cada decisión importante tiene su documento en [docs/](docs/) (autenticación, cifrado de tokens, sincronización confiable, rate limiting, SEO, entre otros).

## Despliegue

`npm run cf:deploy` publica el build en Cloudflare Pages. Las migraciones de producción se aplican con `npm run db:migrate:prod`. El runbook de incidentes y los límites del plan gratuito están en [docs/](docs/).

## Autor

Joaquín Rodríguez, [LinkedIn](https://www.linkedin.com/in/joaquin-e-rodriguez).
