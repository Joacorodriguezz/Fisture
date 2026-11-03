// Intercambia el code por tokens y arma la identidad que informa el proveedor (docs/18 §3.2, paso 2).
import { decodeIdToken } from "arctic";
import { createGoogleProvider, createMicrosoftProvider } from "./providers";
import { emailVerificado, normalizarEmail, type PerfilIdentidad, type Proveedor, type TokensProveedor } from "./identity";

export interface ResultadoProveedor {
  perfil: PerfilIdentidad;
  tokens: TokensProveedor;
}

interface TokensArctic {
  accessToken(): string;
  refreshToken(): string;
  accessTokenExpiresAt(): Date;
  idToken(): string;
}

// El proveedor no siempre reenvía el refresh token (Google solo al consentir): null y se conserva el anterior
function leerTokens(tokens: TokensArctic): TokensProveedor {
  let refreshToken: string | null = null;
  try {
    refreshToken = tokens.refreshToken();
  } catch {
    /* sin refresh token en esta respuesta */
  }
  let vence: number | null = null;
  try {
    vence = tokens.accessTokenExpiresAt()?.getTime() ?? null;
  } catch {
    /* sin vencimiento */
  }
  return { accessToken: tokens.accessToken(), refreshToken, tokenExpiresAt: vence };
}

const texto = (valor: unknown): string | null => (typeof valor === "string" && valor.trim() ? valor : null);

// Una respuesta de error del proveedor (p. ej. 403 por falta de scope) no es un perfil:
// se corta acá para que el log muestre la causa y no un error posterior de D1
async function obtenerPerfil<T>(url: string, accessToken: string): Promise<T> {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!response.ok) throw new Error(`profile_fetch_failed: ${response.status}`);
  return (await response.json()) as T;
}

export async function obtenerIdentidad(env: Env, provider: Proveedor, code: string, codeVerifier: string): Promise<ResultadoProveedor> {
  if (provider === "google") {
    const tokens = await createGoogleProvider(env).validateAuthorizationCode(code, codeVerifier);
    // La identidad sale del ID token firmado por Google (sub, email_verified), no de userinfo v2 (D10).
    // Falla cerrado si falta: decodeIdToken lanza.
    const claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
    const sub = texto(claims.sub);
    if (!sub) throw new Error("id_token_without_sub");
    const email = normalizarEmail(claims.email);
    return {
      tokens: leerTokens(tokens),
      perfil: {
        provider,
        providerId: sub,
        tenantId: null,
        email,
        emailVerified: emailVerificado(provider, claims),
        name: texto(claims.name) ?? (email || null),
        image: texto(claims.picture),
      },
    };
  }

  const tokens = await createMicrosoftProvider(env).validateAuthorizationCode(code, codeVerifier);
  const graph = await obtenerPerfil<{ id?: string; mail?: string; userPrincipalName?: string; displayName?: string }>(
    "https://graph.microsoft.com/v1.0/me",
    tokens.accessToken()
  );
  // El id de Graph es el oid, inmutable. Si el ID token trae un oid distinto algo no cuadra: se corta
  const providerId = texto(graph.id);
  if (!providerId) throw new Error("profile_without_id");
  let claims: Record<string, unknown> = {};
  try {
    claims = decodeIdToken(tokens.idToken()) as Record<string, unknown>;
  } catch {
    /* el tid es solo informativo */
  }
  if (claims.oid !== undefined && claims.oid !== providerId) throw new Error("oid_mismatch");

  return {
    tokens: leerTokens(tokens),
    perfil: {
      provider,
      providerId,
      tenantId: texto(claims.tid),
      // mail y UPN los edita el administrador del tenant: sirven de contacto, jamás de identidad (H3)
      email: normalizarEmail(graph.mail || graph.userPrincipalName),
      emailVerified: emailVerificado(provider, claims),
      name: texto(graph.displayName),
      image: null,
    },
  };
}
