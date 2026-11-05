// Clave de cifrado de tokens para los tests: se genera al cargar el módulo, nunca es una clave real.
import { decryptToken } from "../../src/lib/auth/token-crypto";

export const nuevaClave = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));

export const TOKEN_ENCRYPTION_KEY = nuevaClave();
export const ENV_CON_CLAVE = { TOKEN_ENCRYPTION_KEY } as Env;

// Descifra el valor de una columna (acepta también el legado en claro). El id es el de la fila
export const claro = (valor: string | null, id: string, columna: "access_token" | "refresh_token") =>
  valor === null ? Promise.resolve(null) : decryptToken(ENV_CON_CLAVE, valor, `${id}:${columna}`);

// Filas de un SELECT * con los tokens descifrados (cada fila lleva su id para el AAD)
export const descifrarFilas = <T extends { id: string; access_token?: string | null; refresh_token?: string | null }>(filas: T[]) =>
  Promise.all(
    filas.map(async (f) => ({
      ...f,
      ...("access_token" in f ? { access_token: await claro(f.access_token ?? null, f.id, "access_token") } : {}),
      ...("refresh_token" in f ? { refresh_token: await claro(f.refresh_token ?? null, f.id, "refresh_token") } : {}),
    }))
  );
