// Backfill del cifrado de tokens (docs/15 D5). Idempotente, acotado y paginado: cada corrida mira como máximo
// LOTE_FILAS filas (ordenadas por id, tabla `users` y después `oauth_identities`) y escribe todo en un solo
// batch, para no pasar los 50 subrequests por invocación de Workers Free (como mucho: dos lecturas, dos
// conteos y el batch). La respuesta trae `siguienteCursor`: se repite pasándolo como `cursor` hasta que sea null.
//
// Las escrituras son condicionales sobre el valor leído (`WHERE id = ? AND access_token IS ? AND
// refresh_token IS ?`): si un login o una renovación cambió la fila entre la lectura y el batch, no se pisa
// y la fila cuenta como pendiente para la próxima pasada.
import { and, eq, isNull, sql, type SQL } from "drizzle-orm";
import { oauthIdentities, users } from "../../../drizzle/schema";
import type { Database } from "../db";
import { decryptTokenInfo, encryptToken, esCifrado, PREFIJO_CIFRADO, TokenKeyError, type ClavesEnv } from "./token-crypto";
import { aadToken, type ColumnaToken } from "./token-store";

export const LOTE_FILAS = 20;

export type Direccion = "encrypt" | "decrypt";

export interface ResultadoBackfill {
  direccion: Direccion;
  // Cursor recibido y el que hay que pasar en la próxima llamada (null = terminó la pasada)
  cursor: string | null;
  siguienteCursor: string | null;
  // Filas realmente escritas en esta llamada
  procesadas: number;
  // Filas de esta página que no se pudieron leer (clave equivocada o valor alterado): no se tocan ni cuentan como pendientes
  ilegibles: number;
  // Por convertir: las que cambiaron durante la corrida (se saltean) más las que quedan después del cursor
  pendientes: number;
}

export class CursorInvalidoError extends Error {
  constructor() {
    super("cursor_invalido");
    this.name = "CursorInvalidoError";
  }
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
const CON_TOKENS = sql`(access_token IS NOT NULL OR refresh_token IS NOT NULL)`;

const nombre = (t: Tabla) => sql.raw(t);

async function contar(db: Database, tabla: Tabla, donde: SQL, despuesDe = ""): Promise<number> {
  const [fila] = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM ${nombre(tabla)} WHERE id > ${despuesDe} AND ${donde}`);
  return Number(fila?.n ?? 0);
}

// Conteo para /api/admin/status: tokens que siguen en texto plano
export async function contarTokensSinCifrar(db: Database): Promise<{ usuarios: number; identidades: number }> {
  return { usuarios: await contar(db, "users", SIN_CIFRAR), identidades: await contar(db, "oauth_identities", SIN_CIFRAR) };
}

// Formato `tabla:id`. El id puede tener ':' (se parte por el primero)
function leerCursor(cursor: string | null | undefined): { tabla: Tabla; id: string } | null {
  if (!cursor) return null;
  const i = cursor.indexOf(":");
  const tabla = cursor.slice(0, i) as Tabla;
  const id = cursor.slice(i + 1);
  if (i < 0 || !TABLAS.includes(tabla) || !id) throw new CursorInvalidoError();
  return { tabla, id };
}

// Valor final de una columna según la dirección. null = no cambia. Lanza si no se puede leer
async function nuevoValor(env: ClavesEnv, direccion: Direccion, fila: FilaTokens, columna: ColumnaToken): Promise<string | null> {
  const actual = fila[columna];
  if (actual === null) return null;
  const aad = aadToken(fila.id, columna);
  // Release B (docs/15 K18): la app ya no lee valores en claro, pero este recorrido sí los ve: los cifra (encrypt)
  // o los deja como están (decrypt). Es la única lectura de texto plano que queda, y no sale del backfill
  if (!esCifrado(actual)) return direccion === "encrypt" ? encryptToken(env, actual, aad) : null;
  const { valor, clave } = await decryptTokenInfo(env, actual, aad);
  if (direccion === "decrypt") return valor;
  return clave === "actual" ? null : encryptToken(env, valor, aad);
}

type Cambios = { accessToken?: string; refreshToken?: string };

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

// UPDATE condicional sobre lo leído: si la fila cambió, no toca nada
function actualizar(db: Database, tabla: Tabla, fila: FilaTokens, cambios: Cambios) {
  const t = tabla === "users" ? users : oauthIdentities;
  const igual = (col: typeof t.accessToken | typeof t.refreshToken, valor: string | null) => (valor === null ? isNull(col) : eq(col, valor));
  const donde = and(eq(t.id, fila.id), igual(t.accessToken, fila.access_token), igual(t.refreshToken, fila.refresh_token));
  return db.update(t).set(cambios).where(donde).returning({ id: t.id });
}

export async function procesarTokens(env: ClavesEnv, db: Database, direccion: Direccion, cursor?: string | null): Promise<ResultadoBackfill> {
  const desde = leerCursor(cursor);
  // encrypt: filas en claro y, con clave anterior cargada, todas las que tengan tokens (para rotar las que usan
  // la anterior). decrypt: las cifradas (solo rollback)
  const rotando = direccion === "encrypt" && Boolean(env.TOKEN_ENCRYPTION_KEY_PREVIOUS);
  const base = direccion === "decrypt" ? CIFRADAS : rotando ? CON_TOKENS : SIN_CIFRAR;

  let restante = LOTE_FILAS;
  let ilegibles = 0;
  let siguienteCursor: string | null = null;
  let ultimo: string | null = null;
  const hechas: Array<{ tabla: Tabla; fila: FilaTokens; cambios: Cambios }> = [];

  for (const tabla of TABLAS.slice(desde ? TABLAS.indexOf(desde.tabla) : 0)) {
    if (restante === 0) {
      siguienteCursor = ultimo;
      break;
    }
    const despuesDe = desde?.tabla === tabla ? desde.id : "";
    // Una fila de más para saber si queda algo en esta tabla
    const leidas = await db.all<FilaTokens>(
      sql`SELECT id, access_token, refresh_token FROM ${nombre(tabla)} WHERE id > ${despuesDe} AND ${base} ORDER BY id LIMIT ${restante + 1}`
    );
    const pagina = leidas.slice(0, restante);
    for (const fila of pagina) {
      const cambios = await calcular(env, direccion, fila);
      if (cambios === null) ilegibles++;
      else if (Object.keys(cambios).length > 0) hechas.push({ tabla, fila, cambios });
    }
    if (pagina.length > 0) ultimo = `${tabla}:${pagina[pagina.length - 1].id}`;
    if (leidas.length > restante) {
      siguienteCursor = ultimo;
      break;
    }
    restante -= pagina.length;
  }

  // Un solo batch (una subrequest y una transacción) con todo el lote
  let procesadas = 0;
  if (hechas.length > 0) {
    const resultados = (await db.batch(
      hechas.map(({ tabla, fila, cambios }) => actualizar(db, tabla, fila, cambios)) as unknown as [ReturnType<typeof actualizar>, ...ReturnType<typeof actualizar>[]]
    )) as unknown as Array<Array<{ id: string }>>;
    procesadas = resultados.reduce((n, r) => n + r.length, 0);
  }

  // Lo que cambió durante la corrida queda para la próxima; lo que sigue después del cursor, también
  let pendientes = hechas.length - procesadas;
  const resto = leerCursor(siguienteCursor);
  if (resto) {
    for (const tabla of TABLAS.slice(TABLAS.indexOf(resto.tabla))) {
      pendientes += await contar(db, tabla, base, tabla === resto.tabla ? resto.id : "");
    }
  }

  // Al terminar la pasada, la última respuesta es la verdad: se cuenta lo que queda en la dirección pedida,
  // incluidas las filas salteadas o ilegibles de páginas anteriores. Con rotación (CON_TOKENS) no se puede
  // saber qué filas usan la clave anterior sin leerlas, así que sigue siendo la cuenta parcial
  if (!resto && !rotando) {
    pendientes = 0;
    for (const tabla of TABLAS) pendientes += await contar(db, tabla, base);
  }

  return { direccion, cursor: desde ? `${desde.tabla}:${desde.id}` : null, siguienteCursor, procesadas, ilegibles, pendientes };
}
