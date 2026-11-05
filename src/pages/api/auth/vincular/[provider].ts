import type { APIRoute } from "astro";
import { isValidProvider } from "../../../../lib/auth/providers";
import { withApi } from "../../../../lib/observability/with-api";
import { iniciarAutorizacion } from "../../../../lib/auth/iniciar";

// Inicia la vinculación de otro proveedor a la cuenta con sesión (docs/18 D3.2). El callback es el mismo
// de siempre: el estado firmado lleva intent "link" y el usuario que lo inició. POST + Origin como el resto
// de las mutaciones: un GET cross-site no puede arrancar una vinculación.
export const POST: APIRoute = withApi(async ({ params, redirect, cookies, locals }) => {
  const user = locals.user;
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const env = locals.runtime.env;

  const { provider } = params;
  if (!provider || !isValidProvider(provider)) {
    return Response.json({ error: "Provider not supported" }, { status: 400 });
  }

  if (!env.OAUTH_STATE_SECRET) {
    locals.logger?.error("oauth_state_secret_missing", { provider });
    return redirect("/configuracion?error=oauth_unavailable", 303);
  }

  return redirect(await iniciarAutorizacion({ env, secret: env.OAUTH_STATE_SECRET, cookies, provider, next: null, intent: "link", userId: user.id }), 303);
}, { contentType: "any" }); // formulario HTML de Configuración: POST sin cuerpo JSON
