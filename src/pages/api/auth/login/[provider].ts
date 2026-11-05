import type { APIRoute } from "astro";
import { isValidProvider } from "../../../../lib/auth/providers";
import { withApi } from "../../../../lib/observability/with-api";
import { safeNext } from "../../../../lib/auth/guards";
import { iniciarAutorizacion } from "../../../../lib/auth/iniciar";

export const GET: APIRoute = withApi(async ({ params, url, redirect, cookies, locals }) => {
  const { provider } = params;
  const env = locals.runtime.env;

  if (!provider || !isValidProvider(provider)) {
    return new Response("Provider not supported", { status: 400 });
  }

  // Falla cerrada: sin el secret no se puede firmar el estado, y no se escribe nada
  if (!env.OAUTH_STATE_SECRET) {
    locals.logger?.error("oauth_state_secret_missing", { provider });
    return redirect("/login?error=oauth_unavailable");
  }

  return redirect(await iniciarAutorizacion({ env, secret: env.OAUTH_STATE_SECRET, cookies, provider, next: safeNext(url.searchParams.get("next")) }));
}, { rateLimit: ["login"] });
