// Backfill del cifrado de tokens (docs/15 D5). Idempotente y acotado: cada corrida escribe como máximo
// LOTE_FILAS filas en un solo batch, para no pasar los 50 subrequests por invocación de Workers Free
// (por tabla: un conteo, una lectura acotada y, con clave anterior cargada, una lectura de las cifradas).
// Se repite hasta que `pendientes` sea 0.
import { eq, sql } from "drizzle-orm";
import { oauthIdentities, users } from "../../../drizzle/schema";
import type { Database } from "../db";
import { decryptTokenInfo, encryptToken, PREFIJO_CIFRADO, TokenKeyError, type ClavesEnv } from "./token-crypto";
import { aadToken, type ColumnaToken } from "./token-store";

export const LOTE_FILAS = 20;

export type Direccion = "encrypt" | "decrypt";

export interface ResultadoBackfill {
  direccion: Direccion;
  procesadas: number;
  // Filas cifradas que no se pudieron leer (clave equivocada o valor alterado): no se tocan
  ilegibles: number;
  pendientes: number;
}

interface FilaTokens {
  id: string;
  access_token: string | null;
  refresh_token: string | null;
}

type Tabla = "users" | "oauth_identities";
const TABLAS: Tabla[] = ["users", "oauth_identities"];
const COLUMNAS: ColumnaToken[] = ["access_token", "refresh_token"];

const SIN_CIFRAR = sql`((access_token IS NOT NULL AND access_token NOT LIKE ${PREFIJO_CIFRADO + "%"}) OR (refresh_token IS NOT NULL AND refresh_token NOT LIKE ${PREFIJO_CIFRADO + "%"}))`;
const CIFRADAS = sql`((access_token LIKE ${PREFIJO_CIFRADO + "%"}) OR (refresh_token LIKE ${PREFIJO_CIFRADO + "%"}))`;

const nombre = (t: Tabla) => sql.raw(t);

async function contar(db: Database, tabla: Tabla, donde: ReturnType<typeof sql>): Promise<number> {
  const [fila] = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${nombre(tabla)} WHERE ${donde}`);
  return Number(fila?.n ?? 0);
}

// Conteo para /api/admin/status: tokens que siguen en texto plano
export async function contarTokensSinCifrar(db: Database): Promise<{ usuarios: number; identidades: number }> {
  return { usuarios: await contar(db, "users", SIN_CIFRAR), identidades: await contar(db, "oauth_identities", SIN_CIFRAR) };
}

function filas(db: Database, tabla: Tabla, donde: ReturnType<typeof sql>, limite?: number) {
  return db.all<FilaTokens>(
    limite === undefined
      ? sql`SELECT id, access_token, refresh_token FROM ${nombre(tabla)} WHERE ${donde}`
      : sql`SELECT id, access_token, refresh_token FROM ${nombre(tabla)} WHERE ${donde} LIMIT ${limite}`
  );
}

// Valor final de una columna según la dirección. null = no cambia. Lanza si no se puede leer
async function nuevoValor(env: ClavesEnv, direccion: Direccion, fila: FilaTokens, columna: ColumnaToken): Promise<string | null> {
  const actual = fila[columna];
  if (actual === null) return null;
  const aad = aadToken(fila.id, columna);
  const { valor, clave } = await decryptTokenInfo(env, actual, aad);
  if (direccion === "decrypt") return clave === "claro" ? null : valor;
  return clave === "actual" ? null : encryptToken(env, valor, aad);
}

type Cambios = { accessToken?: string; refreshToken?: string };
type Escritura = Parameters<Database["batch"]>[0][number];

// null = la fila no se puede leer (clave equivocada o valor alterado)
async function calcular(env: ClavesEnv, direccion: Direccion, fila: FilaTokens): Promise<Cambios | null> {
  const cambios: Cambios = {};
  for (const columna of COLUMNAS) {
    try {
      const valor = await nuevoValor(env, direccion, fila, columna);
      if (valor !== null) cambios[columna === "access_token" ? "accessToken" : "refreshToken"] = valor;
    } catch (error) {
      if (error instanceof TokenKeyError) throw error; // sin clave no es una fila ilegible: se corta
      return null;
    }
  }
  return cambios;
}

export async function procesarTokens(env: ClavesEnv, db: Database, direccion: Direccion): Promise<ResultadoBackfill> {
  // encrypt: filas en claro y, si hay clave anterior, las cifradas con ella. decrypt: las cifradas (solo rollback)
  const rotando = direccion === "encrypt" && Boolean(env.TOKEN_ENCRYPTION_KEY_PREVIOUS);
  const base = direccion === "decrypt" ? CIFRADAS : SIN_CIFRAR;
  let restante = LOTE_FILAS;
  let ilegibles = 0;
  let total = 0;
  const escrituras: Escritura[] = [];

  for (const tabla of TABLAS) {
    const aConvertir = await contar(db, tabla, base);
    total += aConvertir;
    const lote = aConvertir > 0 && restante > 0 ? await filas(db, tabla, base, restante) : [];
    // La rotación necesita mirar las cifradas para saber cuáles usan la clave anterior (solo con PREVIOUS cargada)
    const cifradas = rotando ? await filas(db, tabla, CIFRADAS) : [];

    const hechas: Array<{ fila: FilaTokens; cambios: Cambios }> = [];
    for (const fila of lote) {
      const cambios = await calcular(env, direccion, fila);
      if (cambios === null) ilegibles++;
      else if (Object.keys(cambios).length > 0) hechas.push({ fila, cambios });
    }
    for (const fila of cifradas) {
      const cambios = await calcular(env, direccion, fila);
      if (cambios === null) ilegibles++;
      else if (Object.keys(cambios).length > 0) {
        total++;
        hechas.push({ fila, cambios });
      }
    }

    for (const { fila, cambios } of hechas.slice(0, restante)) {
      escrituras.push(
        tabla === "users"
          ? db.update(users).set(cambios).where(eq(users.id, fila.id))
          : db.update(oauthIdentities).set(cambios).where(eq(oauthIdentities.id, fila.id))
      );
    }
    restante -= Math.min(hechas.length, restante);
  }

  // Un solo batch (una subrequest y una transacción) con todo el lote
  if (escrituras.length > 0) await db.batch(escrituras as [Escritura, ...Escritura[]]);
  return { direccion, procesadas: escrituras.length, ilegibles, pendientes: total - escrituras.length };
}
