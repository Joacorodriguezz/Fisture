import type { APIRoute } from "astro";
import { createGoogleProvider, createMicrosoftProvider, isValidProvider } from "../../../../lib/auth/providers";
import { leerEstado, nombreCookieEstado } from "../../../../lib/auth/oauth-state";
import { createSession } from "../../../../lib/auth/session";
import { createDb } from "../../../../lib/db";
import { users } from "../../../../../drizzle/schema";
import { eq } from "drizzle-orm";
import { withApi } from "../../../../lib/observability/with-api";
import { safeNext } from "../../../../lib/auth/guards";

export const GET: APIRoute = withApi(async ({ params, url, redirect, cookies, locals }) => {
  const { provider } = params;
  const env = locals.runtime.env;

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return redirect("/login?error=missing_params");
  }

  if (!provider || !isValidProvider(provider)) {
    return redirect("/login?error=unsupported_provider");
  }

  if (!env.OAUTH_STATE_SECRET) {
    locals.logger?.error("oauth_state_secret_missing", { provider });
    return redirect("/login?error=oauth_unavailable");
  }

  const nombreCookie = nombreCookieEstado(provider);
  const estado = await leerEstado(env.OAUTH_STATE_SECRET, cookies.get(nombreCookie)?.value, { state, provider });
  // Se borra siempre: un intento se consume tenga éxito o no el intercambio del code
  cookies.delete(nombreCookie, { path: "/api/auth" });
  if (!estado) {
    return redirect("/login?error=invalid_state");
  }

  const { codeVerifier, next } = estado;

  try {
    let tokens;
    let userInfo: { email: string; name: string; image?: string; providerId: string };

    if (provider === "google") {
      const google = createGoogleProvider(env);
      tokens = await google.validateAuthorizationCode(code, codeVerifier);

      const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.accessToken()}` },
      });
      const profile = await response.json() as { email: string; name: string; picture?: string; id: string };

      userInfo = {
        email: profile.email,
        name: profile.name,
        image: profile.picture,
        providerId: profile.id,
      };
    } else if (provider === "microsoft") {
      const microsoft = createMicrosoftProvider(env);
      tokens = await microsoft.validateAuthorizationCode(code, codeVerifier);

      const response = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokens.accessToken()}` },
      });
      const profile = await response.json() as { mail?: string; userPrincipalName: string; displayName: string; id: string };

      userInfo = {
        email: profile.mail || profile.userPrincipalName,
        name: profile.displayName,
        providerId: profile.id,
      };
    } else {
      return redirect("/login?error=unsupported_provider");
    }

    const db = createDb(env.DB);

    let user = await db.query.users.findFirst({
      where: eq(users.email, userInfo.email),
    });

    if (user) {
      await db
        .update(users)
        .set({
          accessToken: tokens.accessToken(),
          refreshToken: tokens.refreshToken(),
          tokenExpiresAt: tokens.accessTokenExpiresAt()?.getTime(),
          name: userInfo.name,
          image: userInfo.image,
        })
        .where(eq(users.id, user.id));
    } else {
      const [newUser] = await db
        .insert(users)
        .values({
          email: userInfo.email,
          name: userInfo.name,
          image: userInfo.image,
          provider: provider!,
          providerId: userInfo.providerId,
          accessToken: tokens.accessToken(),
          refreshToken: tokens.refreshToken(),
          tokenExpiresAt: tokens.accessTokenExpiresAt()?.getTime(),
        })
        .returning();

      user = newUser;
    }

    const sessionId = await createSession(env.KV, user.id);

    cookies.set("session", sessionId, {
      path: "/",
      httpOnly: true,
      secure: env.ENVIRONMENT === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });

    // next se validó al iniciar el login y se vuelve a validar acá antes de redirigir
    return redirect(safeNext(next) ?? "/ligas");
  } catch (error) {
    locals.logger?.error("oauth_failed", { provider: params.provider, err: error });
    return redirect("/login?error=oauth_failed");
  }
});
