import { eq } from "drizzle-orm";
import { oauthIdentities, users } from "../../../drizzle/schema";
import type { Database } from "../db";
import { createGoogleProvider, createMicrosoftProvider } from "./providers";
import { buscarIdentidadDeUsuario, type Proveedor } from "./identity";

type DbUser = typeof users.$inferSelect;

const CALENDAR_SCOPES = {
  google: ["https://www.googleapis.com/auth/calendar.events"],
  microsoft: ["Calendars.ReadWrite", "offline_access"],
};

export interface OpcionesToken {
  // Renovar aunque el token parezca vigente: el proveedor lo rechazó con un 401 (docs/17 I2)
  forzarRenovacion?: boolean;
  // Se llama justo antes de la llamada de red que renueva (el sync por lotes la suma a su presupuesto)
  alRenovar?: () => void;
}

// Devuelve un access token vigente para la API de calendario.
// Los tokens salen de la identidad del proveedor de calendario activo (users.provider, docs/18 D4);
// si el usuario todavía no tiene identidad (legado, D6) se usan los de users.*.
// Si el token venció y hay refresh token, lo renueva y guarda el nuevo. Además actualiza `user` en
// memoria: quien siga usándolo (p. ej. una segunda renovación, con el refresh token rotado de
// Microsoft) no parte de tokens viejos.
export async function getValidAccessToken(
  env: Env,
  db: Database,
  user: DbUser,
  opciones: OpcionesToken = {}
): Promise<string> {
  const identidad = await buscarIdentidadDeUsuario(db, user.id, user.provider as Proveedor);
  const fuente = identidad ?? user;

  if (!fuente.accessToken) {
    throw new Error("No calendar access token");
  }

  const expiresAt = fuente.tokenExpiresAt;
  const stillValid = !expiresAt || expiresAt > Date.now() + 60_000;
  if (stillValid && !opciones.forzarRenovacion) return fuente.accessToken;

  if (!fuente.refreshToken) {
    throw new Error("Calendar permission expired. Volvé a iniciar sesión.");
  }

  opciones.alRenovar?.();

  let tokens;
  if (user.provider === "google") {
    tokens = await createGoogleProvider(env).refreshAccessToken(fuente.refreshToken);
  } else if (user.provider === "microsoft") {
    tokens = await createMicrosoftProvider(env).refreshAccessToken(
      fuente.refreshToken,
      CALENDAR_SCOPES.microsoft
    );
  } else {
    throw new Error("Unsupported provider");
  }

  const accessToken = tokens.accessToken();
  const nuevos = {
    accessToken,
    tokenExpiresAt: tokens.accessTokenExpiresAt()?.getTime() ?? null,
    // Google no siempre devuelve un refresh token nuevo: conservamos el anterior
    refreshToken: safeRefreshToken(tokens) ?? fuente.refreshToken,
  };

  // Doble escritura (docs/18 D6): users.* sigue vigente hasta el release N+1
  const actualizarUsuario = db.update(users).set(nuevos).where(eq(users.id, user.id));
  if (identidad) {
    await db.batch([db.update(oauthIdentities).set(nuevos).where(eq(oauthIdentities.id, identidad.id)), actualizarUsuario]);
  } else {
    await actualizarUsuario;
  }
  Object.assign(user, nuevos);

  return accessToken;
}

function safeRefreshToken(tokens: { refreshToken(): string }): string | null {
  try {
    return tokens.refreshToken();
  } catch {
    return null;
  }
}
