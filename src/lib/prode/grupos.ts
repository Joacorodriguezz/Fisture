// Grupos privados del prode: se crean con un nombre y se entra solo con el código de invitación.
// Los integrantes se ven entre sí sin exponer email ni ids.
import { and, asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db";
import { prodeGroupMembers, prodeGroups, users } from "../../../drizzle/schema";
import { validarTextoPublico } from "./nombre-visible";

export const NOMBRE_MIN = 3;
export const NOMBRE_MAX = 40;
// Para quien todavía no eligió nombre visible (users.display_name es null)
export const NOMBRE_GENERICO = "Participante";

// 16 bytes aleatorios (128 bits) en base64url: 22 caracteres, imposible de adivinar
const BYTES_CODIGO = 16;
const FORMATO_CODIGO = /^[A-Za-z0-9_-]{22}$/;

export interface GrupoCreado {
  id: string;
  name: string;
  inviteCode: string;
}

export interface GrupoResumen {
  id: string;
  name: string;
  esDueno: boolean;
  integrantes: number;
}

export interface Integrante {
  nombre: string;
  esDueno: boolean;
  esVos: boolean;
}

export interface GrupoDetalle {
  id: string;
  name: string;
  esDueno: boolean;
  // Solo para el dueño: es quien comparte el enlace
  inviteCode?: string;
  integrantes: Integrante[];
}

export function normalizarNombre(valor: unknown): string | null {
  // Mismas reglas que el nombre visible (code points, sin invisibles/bidi, sin emails ni URLs), rango propio
  const r = validarTextoPublico(valor, NOMBRE_MIN, NOMBRE_MAX);
  return r.ok ? r.texto : null;
}

export function generarCodigoInvitacion(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(BYTES_CODIGO));
  let binario = "";
  for (const b of bytes) binario += String.fromCharCode(b);
  return btoa(binario).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function codigoValido(valor: unknown): valor is string {
  return typeof valor === "string" && FORMATO_CODIGO.test(valor);
}

// Tope de grupos creados por dueño (los grupos a los que solo se une no cuentan)
export const MAX_GRUPOS_POR_DUENO = 10;

export async function contarGruposCreados(db: Database, ownerId: string): Promise<number> {
  const [fila] = await db.select({ n: sql<number>`count(*)` }).from(prodeGroups).where(eq(prodeGroups.ownerId, ownerId));
  return Number(fila?.n ?? 0);
}

export async function crearGrupo(db: Database, ownerId: string, nombre: unknown, ahora = Date.now()): Promise<GrupoCreado | null> {
  const name = normalizarNombre(nombre);
  if (!name) return null;
  const grupo = { id: crypto.randomUUID(), name, inviteCode: generarCodigoInvitacion(), ownerId, createdAt: ahora };
  await db.batch([
    db.insert(prodeGroups).values(grupo),
    db.insert(prodeGroupMembers).values({ groupId: grupo.id, userId: ownerId, joinedAt: ahora }),
  ]);
  return { id: grupo.id, name, inviteCode: grupo.inviteCode };
}

// Idempotente: unirse dos veces (o el dueño a su propio grupo) no duplica ni falla
export async function unirseConCodigo(db: Database, userId: string, codigo: unknown, ahora = Date.now()): Promise<{ id: string; name: string } | null> {
  if (!codigoValido(codigo)) return null;
  const [grupo] = await db
    .select({ id: prodeGroups.id, name: prodeGroups.name })
    .from(prodeGroups)
    .where(eq(prodeGroups.inviteCode, codigo))
    .limit(1);
  if (!grupo) return null;
  await db.insert(prodeGroupMembers).values({ groupId: grupo.id, userId, joinedAt: ahora }).onConflictDoNothing();
  return grupo;
}

export async function misGrupos(db: Database, userId: string): Promise<GrupoResumen[]> {
  const filas = await db
    .select({
      id: prodeGroups.id,
      name: prodeGroups.name,
      ownerId: prodeGroups.ownerId,
      integrantes: sql<number>`(SELECT count(*) FROM prode_group_members AS m2 WHERE m2.group_id = ${prodeGroups.id})`,
    })
    .from(prodeGroupMembers)
    .innerJoin(prodeGroups, eq(prodeGroups.id, prodeGroupMembers.groupId))
    .where(eq(prodeGroupMembers.userId, userId))
    .orderBy(asc(prodeGroupMembers.joinedAt), asc(prodeGroups.name));
  return filas.map((f) => ({ id: f.id, name: f.name, esDueno: f.ownerId === userId, integrantes: Number(f.integrantes) }));
}

// null tanto si el grupo no existe como si el usuario no es integrante (el endpoint responde 404 uniforme)
export async function detalleGrupo(db: Database, userId: string, groupId: string): Promise<GrupoDetalle | null> {
  const [grupo] = await db
    .select({ id: prodeGroups.id, name: prodeGroups.name, ownerId: prodeGroups.ownerId, inviteCode: prodeGroups.inviteCode })
    .from(prodeGroups)
    .innerJoin(prodeGroupMembers, and(eq(prodeGroupMembers.groupId, prodeGroups.id), eq(prodeGroupMembers.userId, userId)))
    .where(eq(prodeGroups.id, groupId))
    .limit(1);
  if (!grupo) return null;

  const miembros = await db
    .select({ userId: prodeGroupMembers.userId, displayName: users.displayName })
    .from(prodeGroupMembers)
    .innerJoin(users, eq(users.id, prodeGroupMembers.userId))
    .where(eq(prodeGroupMembers.groupId, groupId))
    .orderBy(asc(prodeGroupMembers.joinedAt));

  const esDueno = grupo.ownerId === userId;
  return {
    id: grupo.id,
    name: grupo.name,
    esDueno,
    ...(esDueno ? { inviteCode: grupo.inviteCode } : {}),
    integrantes: miembros.map((m) => ({ nombre: m.displayName ?? NOMBRE_GENERICO, esDueno: m.userId === grupo.ownerId, esVos: m.userId === userId })),
  };
}
