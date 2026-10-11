# FISTURE - Fixture Sync

App para sincronizar partidos de fútbol con tu calendario personal.

## Stack

- **Frontend**: Astro (SSR) + React (islands) + Tailwind CSS
- **Backend**: Cloudflare Workers (APIs)
- **Database**: Cloudflare D1 (SQLite) + Drizzle ORM
- **Cache**: Cloudflare KV (sesiones)
- **Auth**: Arctic + Oslo (OAuth)
- **Deploy**: Cloudflare Pages

## Comandos

```bash
npm run dev          # Servidor de desarrollo
npm run build        # Build para producción
npm run db:generate  # Generar migraciones Drizzle
npm run db:migrate:local  # Aplicar migraciones localmente
npm run db:migrate:prod   # Aplicar migraciones en producción
npm run sync:check        # Verificar el sync de competencias (ESPN) contra una D1 efímera
```

## Estructura

```
src/
├── pages/           # Rutas (Astro file-based routing)
│   └── api/         # API endpoints (Workers)
├── components/      # Componentes Astro y React
├── layouts/         # Layouts
└── lib/             # Lógica de negocio
    ├── db/          # Cliente y queries D1
    ├── auth/        # OAuth y sesiones
    ├── football-api/# Cliente API-Football
    └── calendar/    # Integración calendarios

drizzle/
├── schema.ts        # Schema de tablas
├── migrations/      # SQL migrations
└── seed.ts          # Datos iniciales
```

## Convenciones

- Archivos `.astro` para páginas y componentes estáticos (0 JS)
- Archivos `.tsx` en `components/islands/` para interactividad (React)
- APIs en `pages/api/` se despliegan como Workers
- Usar `client:visible` para islands que requieren JS
