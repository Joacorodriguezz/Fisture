import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { Database } from "../db";
import { sessions, users, type User } from "../../../drizzle/schema";

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 días, fijo: no se renueva por request (docs/21 D4)
const PURGE_TOPE = 500;

// 32 bytes de aleatoriedad criptográfica codificados en base64url sin
// relleno (43 caracteres). Math.random no sirve: no es seguro para credenciales.
function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// La base guarda sha256(token) en hexadecimal: una filtración de la tabla no regala sesiones válidas.
export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const enSegundos = (fecha: Date) => Math.floor(fecha.getTime() / 1000);

// Devuelve el token en claro, que va solo a la cookie
export async function createSession(db: Database, userId: string, ahora: Date = new Date()): Promise<string> {
  const token = generateSessionToken();
  const creada = enSegundos(ahora);
  await db.insert(sessions).values({
    id: await hashToken(token),
    userId,
    createdAt: creada,
    expiresAt: creada + SESSION_TTL_SECONDS,
  });
  return token;
}

// Una sola consulta: sesión vigente + usuario. Hash inexistente, sesión vencida y usuario borrado dan null.
export async function getSessionUser(db: Database, token: string, ahora: Date = new Date()): Promise<User | null> {
  if (!token) return null;
  const [fila] = await db
    .select({ user: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, await hashToken(token)), gt(sessions.expiresAt, enSegundos(ahora))))
    .limit(1);
  return fila?.user ?? null;
}

export async function deleteSession(db: Database, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, await hashToken(token)));
}

// Habilitada para "cerrar sesión en todos los dispositivos"; todavía sin UI (docs/21 Q3)
export async function deleteUserSessions(db: Database, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

// Higiene del sync diario: las vencidas ya no autentican. Devuelve cuántas borró (hasta `tope`).
export async function purgeExpiredSessions(db: Database, ahora: Date = new Date(), tope = PURGE_TOPE): Promise<number> {
  const vencidas = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(lt(sessions.expiresAt, enSegundos(ahora)))
    .limit(tope);
  if (vencidas.length === 0) return 0;
  await db.delete(sessions).where(inArray(sessions.id, vencidas.map((s) => s.id)));
  return vencidas.length;
}

// Para /api/admin/status (docs/21 Q2): solo conteos, nunca ids ni usuarios
export async function countSessions(db: Database, ahora: Date = new Date()): Promise<{ vigentes: number; vencidas: number }> {
  const corte = enSegundos(ahora);
  const [fila] = await db
    .select({
      vigentes: sql<number>`coalesce(sum(case when ${sessions.expiresAt} > ${corte} then 1 else 0 end), 0)`,
      vencidas: sql<number>`coalesce(sum(case when ${sessions.expiresAt} <= ${corte} then 1 else 0 end), 0)`,
    })
    .from(sessions);
  return { vigentes: Number(fila?.vigentes ?? 0), vencidas: Number(fila?.vencidas ?? 0) };
}
