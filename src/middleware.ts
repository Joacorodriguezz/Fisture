import { defineMiddleware } from "astro:middleware";
import { getSession } from "./lib/auth/session";
import { decidirAcceso, loginHref } from "./lib/auth/guards";
import { createDb } from "./lib/db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";

// La web se navega sin sesión. El middleware solo carga el usuario (si hay) y aplica
// las reglas de lib/auth/guards.ts a las pocas rutas que sí exigen cuenta.
export const onRequest = defineMiddleware(
  async ({ locals, cookies, url, redirect }, next) => {
    const env = locals.runtime.env;

    const sessionId = cookies.get("session")?.value;
    if (sessionId) {
      const userId = await getSession(env.KV, sessionId);
      const user = userId
        ? await createDb(env.DB).query.users.findFirst({ where: eq(users.id, userId) })
        : undefined;

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
