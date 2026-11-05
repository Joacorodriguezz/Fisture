import type { APIRoute } from "astro";
import { createDb } from "../../../lib/db";
import { deleteSession } from "../../../lib/auth/session";
import { withApi } from "../../../lib/observability/with-api";

// Cerrar sesión cambia estado: solo por POST, con la verificación de origen de withApi (un GET lo podía
// disparar un sitio ajeno con un <img>, docs/16 §12). El formulario del navegador envía application/x-www-form-urlencoded
// (aunque vacío), por eso no se exige JSON.
export const POST: APIRoute = withApi(
  async ({ cookies, redirect, locals }) => {
    const sessionId = cookies.get("session")?.value;

    if (sessionId) {
      await deleteSession(createDb(locals.runtime.env.DB), sessionId);
    }

    cookies.delete("session", { path: "/" });
    // 303: el navegador sigue con un GET a / después del POST
    return redirect("/", 303);
  },
  { contentType: "any" }
);

// Un GET no cierra la sesión ni redirige
export const GET: APIRoute = withApi(
  async () => Response.json({ error: "method_not_allowed" }, { status: 405, headers: { Allow: "POST" } }),
  { rateLimit: [] }
);
