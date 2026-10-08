import { defineMiddleware } from "astro:middleware";
import { getSession } from "./lib/auth/session";
import { createDb } from "./lib/db";
import { users } from "../drizzle/schema";
import { eq } from "drizzle-orm";

const PUBLIC_PATHS = ["/", "/login", "/api/auth", "/api/admin"];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(path + "/"));
}

export const onRequest = defineMiddleware(
  async ({ locals, cookies, url, redirect }, next) => {
    const env = locals.runtime.env;

    // Rutas públicas
    if (isPublicPath(url.pathname)) {
      return next();
    }

    // Verificar session
    const sessionId = cookies.get("session")?.value;
    if (!sessionId) {
      return redirect("/login");
    }

    const userId = await getSession(env.KV, sessionId);
    if (!userId) {
      cookies.delete("session", { path: "/" });
      return redirect("/login");
    }

    // Obtener usuario
    const db = createDb(env.DB);
    const user = await db.query.users.findFirst({
      where: eq(users.id, userId),
    });

    if (!user) {
      cookies.delete("session", { path: "/" });
      return redirect("/login");
    }

    // Agregar usuario a locals
    locals.user = user;

    return next();
  }
);
