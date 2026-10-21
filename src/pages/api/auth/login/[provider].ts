import type { APIRoute } from "astro";
import { generateState, generateCodeVerifier } from "arctic";
import { createGoogleProvider, createMicrosoftProvider, isValidProvider } from "../../../../lib/auth/providers";
import { withApi } from "../../../../lib/observability/with-api";

export const GET: APIRoute = withApi(async ({ params, redirect, locals }) => {
  const { provider } = params;
  const env = locals.runtime.env;

  if (!provider || !isValidProvider(provider)) {
    return new Response("Provider not supported", { status: 400 });
  }

  const state = generateState();
  const codeVerifier = generateCodeVerifier();

  await env.KV.put(
    `oauth:${state}`,
    JSON.stringify({ codeVerifier, provider }),
    { expirationTtl: 600 }
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
