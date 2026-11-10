// Único punto por el que los tokens OAuth entran y salen de las columnas (docs/15 D6).
// `id` es el de la fila (users.id u oauth_identities.id): va en el AAD, así un valor copiado
// a otra fila o columna no se puede descifrar.
import { decryptToken, encryptToken, type ClavesEnv } from "./token-crypto";

export type ColumnaToken = "access_token" | "refresh_token";

export const aadToken = (id: string, columna: ColumnaToken) => `${id}:${columna}`;

export interface ParDeTokens {
  accessToken: string | null;
  refreshToken: string | null;
}

// Siempre cifrado: sin clave válida lanza (falla cerrado, nunca guarda en claro)
export async function cifrarTokens(env: ClavesEnv, id: string, t: ParDeTokens): Promise<ParDeTokens> {
  return {
    accessToken: t.accessToken === null ? null : await encryptToken(env, t.accessToken, aadToken(id, "access_token")),
    refreshToken: t.refreshToken === null ? null : await encryptToken(env, t.refreshToken, aadToken(id, "refresh_token")),
  };
}

// Solo cifrado (Release B, docs/15 K18): un valor en claro lanza TokenUnreadableError, igual que uno ilegible
export async function leerToken(env: ClavesEnv, valor: string | null, id: string, columna: ColumnaToken): Promise<string | null> {
  return valor === null ? null : decryptToken(env, valor, aadToken(id, columna));
}

// Para conservar el valor anterior al reescribir: si no se puede leer, se descarta (el proveedor reenvía uno)
export async function leerTokenOpcional(env: ClavesEnv, valor: string | null, id: string, columna: ColumnaToken): Promise<string | null> {
  try {
    return await leerToken(env, valor, id, columna);
  } catch {
    return null;
  }
}
