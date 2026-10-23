import { createGoogleProvider } from "./providers";
import type { Logger } from "../observability/logger";

export interface AccesoARevocar {
  provider: string;
  refreshToken: string | null;
}

// Revoca el consentimiento (grant) del usuario en el proveedor. Es best-effort: nunca lanza.
// Google revoca el grant entero con el refresh token. Microsoft no ofrece un endpoint público
// para esto con nuestros scopes: se le indica al usuario que revoque desde su cuenta.
export async function revocarAcceso(env: Env, acceso: AccesoARevocar, logger?: Logger): Promise<void> {
  if (acceso.provider !== "google" || !acceso.refreshToken) return;
  try {
    await createGoogleProvider(env).revokeToken(acceso.refreshToken);
  } catch (err) {
    const status = (err as { status?: unknown })?.status;
    // Nunca el token ni el mensaje del error (puede incluir la respuesta del proveedor)
    logger?.warn("account_revoke_failed", { provider: acceso.provider, ...(typeof status === "number" ? { status } : {}) });
  }
}
