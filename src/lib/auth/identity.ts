// Identidades OAuth (docs/18-vinculacion-de-cuentas-tdd.md). La identidad de un login es
// (provider, provider_id) con el id inmutable del proveedor; el email nunca identifica a nadie por sí
// solo y solo sirve para unir cuentas cuando el proveedor garantiza que está verificado.
import { and, eq, sql } from "drizzle-orm";
import { oauthIdentities, users, type OAuthIdentity, type User } from "../../../drizzle/schema";
import type { Database } from "../db";

export type Proveedor = "google" | "microsoft";

// ---------- Política (funciones puras) ----------

// trim + minúsculas. No se tocan puntos ni +alias: no se asume que a.b@gmail.com y ab@gmail.com sean la misma persona
export function normalizarEmail(email: unknown): string {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

// Mientras el spike del TDD 18 (paso 0) no confirme que xms_edov se emite de forma fiable, incluidas
// las cuentas personales, Microsoft se trata siempre como no verificado (D2). Nunca se usa mail ni UPN.
export const MICROSOFT_XMS_EDOV_CONFIABLE = false;

export function emailVerificado(
  provider: Proveedor,
  claims: { email_verified?: unknown; xms_edov?: unknown },
  opciones: { confiarXmsEdov?: boolean } = {}
): boolean {
  if (provider === "google") return claims.email_verified === true;
  return (opciones.confiarXmsEdov ?? MICROSOFT_XMS_EDOV_CONFIABLE) && claims.xms_edov === true;
}

// ¿El oid del ID token es la misma cuenta que el id de Graph /me? En cuentas de trabajo son el mismo GUID.
// En cuentas personales (MSA) Graph devuelve el CID de 16 hex y el oid v2 es 00000000-0000-0000-<CID partido
// en 4-12>. Se compara sin guiones y en minúsculas; nunca por sufijo sobre un GUID que no sea de MSA.
const PREFIJO_OID_MSA = "00000000-0000-0000-";
export function oidCoincide(oid: string, graphId: string): boolean {
  const esperado = graphId.toLowerCase().replace(/-/g, "");
  const minusculas = oid.toLowerCase();
  const normalizado = minusculas.startsWith(PREFIJO_OID_MSA) ? minusculas.slice(PREFIJO_OID_MSA.length) : minusculas;
  return normalizado.replace(/-/g, "") === esperado;
}

export type DecisionVinculo = "login" | "crear" | "vincular" | "conflicto";

// D3.1: se une sola únicamente si ambos lados están verificados por su proveedor Y el auto-vínculo está
// prendido (AUTO_VINCULAR_EMAIL_VERIFICADO). Apagado por defecto: docs/18 §11 pedía poder desactivarlo.
export function decidirVinculo(entrada: {
  identidadExistente: boolean;
  identidadVerificada: boolean;
  cuenta: { emailVerified: boolean } | null;
  autoVincular?: boolean;
}): DecisionVinculo {
  if (entrada.identidadExistente) return "login";
  if (!entrada.cuenta) return "crear";
  return entrada.autoVincular === true && entrada.identidadVerificada && entrada.cuenta.emailVerified ? "vincular" : "conflicto";
}

// ---------- Acceso a datos ----------

export interface TokensProveedor {
  accessToken: string | null;
  refreshToken: string | null; // null si el proveedor no lo reenvió: se conserva el anterior (D10)
  tokenExpiresAt: number | null;
}

export interface PerfilIdentidad {
  provider: Proveedor;
  providerId: string;
  tenantId: string | null;
  email: string; // normalizado; "" si el proveedor no entregó uno
  emailVerified: boolean;
  name: string | null;
  image: string | null;
}

const cargaTokens = (t: TokensProveedor, anteriorRefresh?: string | null) => ({
  accessToken: t.accessToken,
  tokenExpiresAt: t.tokenExpiresAt,
  refreshToken: t.refreshToken ?? anteriorRefresh ?? null,
});

export async function buscarIdentidad(db: Database, provider: Proveedor, providerId: string): Promise<OAuthIdentity | undefined> {
  return db.query.oauthIdentities.findFirst({
    where: and(eq(oauthIdentities.provider, provider), eq(oauthIdentities.providerId, providerId)),
  });
}

export async function buscarIdentidadDeUsuario(db: Database, userId: string, provider: Proveedor): Promise<OAuthIdentity | undefined> {
  return db.query.oauthIdentities.findFirst({
    where: and(eq(oauthIdentities.userId, userId), eq(oauthIdentities.provider, provider)),
  });
}

export async function buscarUsuario(db: Database, userId: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: eq(users.id, userId) });
}

// El email solo se usa para decidir una vinculación (nunca para entrar a una cuenta)
export async function buscarUsuarioPorEmail(db: Database, emailNormalizado: string): Promise<User | undefined> {
  return db.query.users.findFirst({ where: sql`lower(${users.email}) = ${emailNormalizado}` });
}

// Fallback legado (D6): usuario creado antes de la migración o en la ventana entre migrar y desplegar.
// Se identifica por provider/provider_id (claves estables), nunca por email.
export async function buscarUsuarioLegado(db: Database, provider: Proveedor, providerId: string): Promise<User | undefined> {
  const usuario = await db.query.users.findFirst({ where: and(eq(users.provider, provider), eq(users.providerId, providerId)) });
  if (!usuario) return undefined;
  // Si ya tiene identidad de este proveedor, la fuente de verdad es esa fila (y no coincide con este providerId)
  return (await buscarIdentidadDeUsuario(db, usuario.id, provider)) ? undefined : usuario;
}

function filaIdentidad(id: string, userId: string, perfil: PerfilIdentidad, tokens: TokensProveedor) {
  return {
    id,
    userId,
    provider: perfil.provider,
    providerId: perfil.providerId,
    tenantId: perfil.tenantId,
    email: perfil.email || null,
    emailVerified: perfil.emailVerified,
    ...cargaTokens(tokens),
  };
}

// Alta de una cuenta nueva: usuario + identidad principal (id = users.id) en un solo batch (una transacción)
export async function crearUsuarioConIdentidad(db: Database, perfil: PerfilIdentidad, tokens: TokensProveedor): Promise<string> {
  const userId = crypto.randomUUID();
  await db.batch([
    db.insert(users).values({
      id: userId,
      email: perfil.email,
      emailVerified: perfil.emailVerified,
      name: perfil.name,
      image: perfil.image,
      provider: perfil.provider,
      providerId: perfil.providerId,
      ...cargaTokens(tokens),
    }),
    db.insert(oauthIdentities).values(filaIdentidad(userId, userId, perfil, tokens)),
  ]);
  return userId;
}

// Asocia una identidad nueva a una cuenta existente. No toca users.* (ni provider ni tokens): V-15
export async function agregarIdentidad(db: Database, userId: string, perfil: PerfilIdentidad, tokens: TokensProveedor, id: string = crypto.randomUUID()): Promise<void> {
  await db.insert(oauthIdentities).values(filaIdentidad(id, userId, perfil, tokens));
}

// Identidad de un usuario anterior a la migración: la principal usa id = users.id (docs/18 §3.1)
export async function crearIdentidadLegada(db: Database, usuario: User, perfil: PerfilIdentidad, tokens: TokensProveedor): Promise<OAuthIdentity> {
  const idLibre = !(await db.query.oauthIdentities.findFirst({ where: eq(oauthIdentities.id, usuario.id) }));
  const id = idLibre ? usuario.id : crypto.randomUUID();
  await agregarIdentidad(db, usuario.id, perfil, { ...tokens, refreshToken: tokens.refreshToken ?? usuario.refreshToken }, id);
  return (await buscarIdentidad(db, perfil.provider, perfil.providerId))!;
}

// Reingreso: actualiza SOLO lo de esa identidad (tokens, email informativo, verificación). Si es la del
// proveedor activo, además escribe users.* (doble escritura de D6) y el nombre y la imagen de la cuenta.
export async function registrarLogin(db: Database, identidad: OAuthIdentity, usuario: User, perfil: PerfilIdentidad, tokens: TokensProveedor): Promise<void> {
  const actualizarIdentidad = db
    .update(oauthIdentities)
    .set({
      ...cargaTokens(tokens, identidad.refreshToken),
      tenantId: perfil.tenantId ?? identidad.tenantId,
      email: perfil.email || identidad.email,
      emailVerified: perfil.emailVerified,
      lastLoginAt: new Date(),
    })
    .where(eq(oauthIdentities.id, identidad.id));
  if (identidad.provider !== usuario.provider) {
    await actualizarIdentidad;
    return;
  }
  const actualizarUsuario = db
    .update(users)
    .set({
      ...cargaTokens(tokens, usuario.refreshToken),
      // Tokens nuevos del calendario activo: vuelve a tener acceso y reentra primero en la cola del sync (docs/17 B4)
      calendarAuthStatus: "ok",
      calendarReconciledAt: null,
      ...(perfil.name ? { name: perfil.name } : {}),
      ...(perfil.image ? { image: perfil.image } : {}),
    })
    .where(eq(users.id, usuario.id));
  await db.batch([actualizarIdentidad, actualizarUsuario]);
}
