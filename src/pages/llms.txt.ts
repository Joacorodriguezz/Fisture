import type { APIContext } from "astro";
import { baseUrl } from "../lib/seo";
import { createDb } from "../lib/db";
import { getPaginasPublicas } from "../lib/db/queries";

// Resumen del sitio para asistentes y buscadores con IA (formato llmstxt.org): qué es FISTURE,
// qué páginas consultar y qué ligas cubre. Se arma con las ligas activas de la base.
export async function GET({ locals }: APIContext): Promise<Response> {
  const env = locals.runtime.env;
  const base = baseUrl(env.PUBLIC_APP_URL);
  const { ligas } = await getPaginasPublicas(createDb(env.DB));

  const texto = `# FISTURE

> FISTURE sincroniza el fixture de fútbol con tu calendario personal (Google Calendar u Outlook). Seguís a tus equipos o ligas y sus partidos aparecen como eventos, con recordatorios 1 hora y 15 minutos antes; si un partido se reprograma, el evento se actualiza solo. Es gratis y está en español (Argentina).

Los horarios se muestran en hora de Argentina (UTC-3). Los datos de partidos se actualizan una vez por día y cubren los próximos 60 días. Ver el fixture no requiere cuenta; sincronizar con el calendario sí (login con Google o Microsoft).

## Páginas principales

- [Partidos de hoy](${base}/hoy): todos los partidos del día, agrupados por liga
- [Próximos partidos](${base}/partidos): fixture de los próximos días
- [Ligas](${base}/ligas): competencias disponibles y sus equipos
- [Buscar equipos](${base}/equipos/buscar): fixture de un equipo puntual
- [Calendario](${base}/calendario): cómo conectar Google Calendar u Outlook

## Ligas y copas

${ligas.map((l) => `- [${l.name}](${base}/ligas/${encodeURIComponent(l.id)}) (${l.country})`).join("\n")}

## Optional

- [Política de privacidad](${base}/privacidad)
- [Términos y condiciones](${base}/terminos)
`;
  return new Response(texto, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
