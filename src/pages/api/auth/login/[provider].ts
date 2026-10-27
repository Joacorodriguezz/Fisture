import type { APIRoute } from "astro";
import { generateState, generateCodeVerifier } from "arctic";
import { createGoogleProvider, createMicrosoftProvider, isValidProvider } from "../../../../lib/auth/providers";
import { withApi } from "../../../../lib/observability/with-api";
import { safeNext } from "../../../../lib/auth/guards";
import { OAUTH_STATE_TTL_SEGUNDOS, crearEstado, nombreCookieEstado } from "../../../../lib/auth/oauth-state";

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

  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  // El estado viaja en una cookie firmada y no en KV: este endpoint es anónimo y público, y cada
  // escritura en KV gasta una cuota diaria compartida por todos (docs/20-login-sin-kv-tdd.md)
  cookies.set(
    nombreCookieEstado(provider),
    await crearEstado(env.OAUTH_STATE_SECRET, {
      state,
      codeVerifier,
      provider,
      next: safeNext(url.searchParams.get("next")),
    }),
    {
      path: "/api/auth",
      httpOnly: true,
      secure: env.ENVIRONMENT === "production",
      sameSite: "lax",
      maxAge: OAUTH_STATE_TTL_SEGUNDOS,
    }
  );

  let authUrl: URL;

  if (provider === "google") {
    const google = createGoogleProvider(env);
    authUrl = google.createAuthorizationURL(state, codeVerifier, [
      "openid",
      "email",
      "profile",
      "https://www.googleapis.com/auth/calendar.events",
    ]);
    authUrl.searchParams.set("access_type", "offline");
    authUrl.searchParams.set("prompt", "consent");
  } else {
    const microsoft = createMicrosoftProvider(env);
    authUrl = microsoft.createAuthorizationURL(state, codeVerifier, [
      "openid",
      "email",
      "profile",
      "Calendars.ReadWrite",
      "offline_access",
    ]);
  }

  return redirect(authUrl.toString());
});
