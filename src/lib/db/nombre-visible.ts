import { eq } from "drizzle-orm";
import { users } from "../../../drizzle/schema";
import type { Database } from "./index";

// Nombre visible del prode. El valor ya llega validado y normalizado (lib/prode/nombre-visible.ts).
export async function getNombreVisible(db: Database, userId: string): Promise<string | null> {
  const fila = await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).get();
  return fila?.displayName ?? null;
}

export async function setNombreVisible(db: Database, userId: string, nombre: string): Promise<void> {
  await db.update(users).set({ displayName: nombre }).where(eq(users.id, userId));
}
