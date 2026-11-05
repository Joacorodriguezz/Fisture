import { eq } from "drizzle-orm";
import { oauthIdentities, users } from "../../../drizzle/schema";
import type { Database } from "../db";
import { createGoogleProvider, createMicrosoftProvider } from "./providers";
import { buscarIdentidadDeUsuario, type Proveedor } from "./identity";
import { cifrarTokens, leerToken } from "./token-store";
import { claveValida, TokenKeyError } from "./token-crypto";

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
  // Antes de cualquier consulta o llamada de red: sin clave un refresh no gasta una subrequest ni rota el
  // refresh token en el proveedor (si se rota y después no se puede guardar, se pierde la credencial)
  if (!claveValida(env)) throw new TokenKeyError();

  const identidad = await buscarIdentidadDeUsuario(db, user.id, user.provider as Proveedor);
  const fuente = identidad ?? user;

  // Acepta cifrado y legado en claro (docs/15 D5). Si no se puede descifrar lanza: el usuario reconecta
  const accessActual = await leerToken(env, fuente.accessToken, fuente.id, "access_token");
  if (!accessActual) {
    throw new Error("No calendar access token");
  }

  const expiresAt = fuente.tokenExpiresAt;
  const stillValid = !expiresAt || expiresAt > Date.now() + 60_000;
  if (stillValid && !opciones.forzarRenovacion) return accessActual;

  const refreshActual = await leerToken(env, fuente.refreshToken, fuente.id, "refresh_token");
  if (!refreshActual) {
    throw new Error("Calendar permission expired. Volvé a iniciar sesión.");
  }

  opciones.alRenovar?.();

  if (user.provider !== "google" && user.provider !== "microsoft") throw new Error("Unsupported provider");
  let tokens;
  try {
    tokens =
      user.provider === "google"
        ? await createGoogleProvider(env).refreshAccessToken(refreshActual)
        : await createMicrosoftProvider(env).refreshAccessToken(refreshActual, CALENDAR_SCOPES.microsoft);
  } catch (error) {
    throw errorDeRenovacion(error);
  }

  const accessToken = tokens.accessToken();
  const tokenExpiresAt = tokens.accessTokenExpiresAt()?.getTime() ?? null;
  // Google no siempre devuelve un refresh token nuevo: conservamos el anterior
  const claros = { accessToken, refreshToken: safeRefreshToken(tokens) ?? refreshActual };

  // Siempre cifrado, con el id de cada fila en el AAD (docs/15 D6). Sin clave lanza antes de escribir
  const paraUsuario = { ...(await cifrarTokens(env, user.id, claros)), tokenExpiresAt };
  // Doble escritura (docs/18 D6): users.* sigue vigente hasta el release N+1
  const actualizarUsuario = db.update(users).set(paraUsuario).where(eq(users.id, user.id));
  if (identidad) {
    const paraIdentidad = { ...(await cifrarTokens(env, identidad.id, claros)), tokenExpiresAt };
    await db.batch([db.update(oauthIdentities).set(paraIdentidad).where(eq(oauthIdentities.id, identidad.id)), actualizarUsuario]);
  } else {
    await actualizarUsuario;
  }
  // En memoria queda el valor cifrado para user.id (nunca tokens en claro ni los de la identidad)
  Object.assign(user, paraUsuario);

  return accessToken;
}

function safeRefreshToken(tokens: { refreshToken(): string }): string | null {
  try {
    return tokens.refreshToken();
  } catch {
    return null;
  }
}

// El error del proveedor puede arrastrar el refresh token en su mensaje: se conserva solo el motivo
// (invalid_grant => el usuario debe reconectar; el resto es transitorio)
function errorDeRenovacion(error: unknown): Error {
  const texto = `${(error as { code?: unknown } | null)?.code ?? ""} ${error instanceof Error ? error.message : ""}`;
  return new Error(/invalid_grant/i.test(texto) ? "refresh_failed: invalid_grant" : "refresh_failed");
}
