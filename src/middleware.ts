import { defineMiddleware, sequence } from "astro:middleware";
import { getSessionUser } from "./lib/auth/session";
import { decidirAcceso, loginHref } from "./lib/auth/guards";
import { createDb } from "./lib/db";
import { conHeadersDeSeguridad } from "./lib/security-headers";
import { destinoDominioCanonico } from "./lib/seo";

// La web se navega sin sesión. El middleware solo carga el usuario (si hay) y aplica
// las reglas de lib/auth/guards.ts a las pocas rutas que sí exigen cuenta.
const sesion = defineMiddleware(
  async ({ locals, cookies, url, redirect }, next) => {
    const env = locals.runtime.env;

    const sessionId = cookies.get("session")?.value;
    if (sessionId) {
      const user = await getSessionUser(createDb(env.DB), sessionId);

      if (user) {
        locals.user = user;
      } else {
        cookies.delete("session", { path: "/" });
      }
    }

    switch (decidirAcceso(url.pathname, !!locals.user)) {
      case "login":
        return redirect(loginHref(url.pathname + url.search));
      case "no_autorizado":
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      default:
        return next();
    }
  }
);

// Un solo dominio para buscadores (docs/29): 301 desde fisture.pages.dev, www., etc. Antes de la sesión,
// así una redirección no toca D1
const dominio = defineMiddleware(async ({ locals, url, request }, next) => {
  const env = locals.runtime.env;
  if (env.ENVIRONMENT !== "production") return next();
  const destino =destinoDominioCanonico(url, request.method, env.ENVIRONMENT, env.PUBLIC_APP_URL);
  return destino ? new Response(null, { status: 301, headers: { Location: destino } }) : next();
});

// Va primero para envolver toda respuesta, incluidas las redirecciones y los 401 de `sesion`
const seguridad = defineMiddleware(async (_context, next) => conHeadersDeSeguridad(await next(), !import.meta.env.DEV));

export const onRequest = sequence(seguridad, dominio, sesion);
