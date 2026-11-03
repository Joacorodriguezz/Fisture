// Arma el intento de autorización OAuth (login o vincular): fija la cookie de estado firmada y devuelve
// la URL del proveedor. Lo comparten /api/auth/login y /api/auth/vincular (docs/18 §3.2).
import type { AstroCookies } from "astro";
import { generateCodeVerifier, generateState } from "arctic";
import { createGoogleProvider, createMicrosoftProvider, type OAuthProvider } from "./providers";
import { OAUTH_STATE_TTL_SEGUNDOS, crearEstado, nombreCookieEstado } from "./oauth-state";

export async function iniciarAutorizacion(opciones: {
  env: Env;
  secret: string; // OAUTH_STATE_SECRET, ya verificado por quien llama
  cookies: AstroCookies;
  provider: OAuthProvider;
  next: string | null;
  intent?: "login" | "link";
  userId?: string;
}): Promise<string> {
  const { env, secret, cookies, provider, next, intent, userId } = opciones;
  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  // El estado viaja en una cookie firmada y no en KV: este endpoint es anónimo y público, y cada
  // escritura en KV gasta una cuota diaria compartida por todos (docs/20-login-sin-kv-tdd.md)
  cookies.set(
    nombreCookieEstado(provider),
    await crearEstado(secret, {
      state,
      codeVerifier,
      provider,
      next,
      ...(intent === "link" ? { intent, userId } : {}),
    }),
    {
      path: "/api/auth",
      httpOnly: true,
      // Staging también se sirve por HTTPS (docs/26)
      secure: env.ENVIRONMENT === "production" || env.ENVIRONMENT === "staging",
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
      // Lo exige Graph para leer /me en el callback (sin él responde 403)
      "User.Read",
      "Calendars.ReadWrite",
      "offline_access",
    ]);
  }

  return authUrl.toString();
}
