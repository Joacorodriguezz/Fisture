import { eq } from "drizzle-orm";
import { users } from "../../../drizzle/schema";
import type { Database } from "../db";
import { createGoogleProvider, createMicrosoftProvider } from "./providers";

type DbUser = typeof users.$inferSelect;

const CALENDAR_SCOPES = {
  google: ["https://www.googleapis.com/auth/calendar.events"],
  microsoft: ["Calendars.ReadWrite", "offline_access"],
};

// Devuelve un access token vigente para la API de calendario.
// Si el token venció y hay refresh token, lo renueva y guarda el nuevo.
export async function getValidAccessToken(
  env: Env,
  db: Database,
  user: DbUser
): Promise<string> {
  if (!user.accessToken) {
    throw new Error("No calendar access token");
  }

  const expiresAt = user.tokenExpiresAt;
  const stillValid = !expiresAt || expiresAt > Date.now() + 60_000;
  if (stillValid) return user.accessToken;

  if (!user.refreshToken) {
    throw new Error("Calendar permission expired. Volvé a iniciar sesión.");
  }

  let tokens;
  if (user.provider === "google") {
    tokens = await createGoogleProvider(env).refreshAccessToken(user.refreshToken);
  } else if (user.provider === "microsoft") {
    tokens = await createMicrosoftProvider(env).refreshAccessToken(
      user.refreshToken,
      CALENDAR_SCOPES.microsoft
    );
  } else {
    throw new Error("Unsupported provider");
  }

  const accessToken = tokens.accessToken();
  const newRefresh = safeRefreshToken(tokens);

  await db
    .update(users)
    .set({
      accessToken,
      tokenExpiresAt: tokens.accessTokenExpiresAt()?.getTime() ?? null,
      // Google no siempre devuelve un refresh token nuevo: conservamos el anterior
      refreshToken: newRefresh ?? user.refreshToken,
    })
    .where(eq(users.id, user.id));

  return accessToken;
}

function safeRefreshToken(tokens: { refreshToken(): string }): string | null {
  try {
    return tokens.refreshToken();
  } catch {
    return null;
  }
}
