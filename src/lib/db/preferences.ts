import { eq } from "drizzle-orm";
import { userPreferences } from "../../../drizzle/schema";
import type { Database } from "./index";

export type Theme = "papel" | "nocturna";

export interface Preferences {
  reminder60: boolean;
  reminder15: boolean;
  theme: Theme;
}

export const DEFAULT_PREFERENCES: Preferences = {
  reminder60: true,
  reminder15: true,
  theme: "papel",
};

export async function getPreferences(db: Database, userId: string): Promise<Preferences> {
  const row = await db.query.userPreferences.findFirst({
    where: eq(userPreferences.userId, userId),
  });

  if (!row) return { ...DEFAULT_PREFERENCES };

  return {
    reminder60: row.reminder60,
    reminder15: row.reminder15,
    theme: row.theme === "nocturna" ? "nocturna" : "papel",
  };
}

export async function updatePreferences(
  db: Database,
  userId: string,
  changes: Partial<Preferences>
): Promise<Preferences> {
  const current = await getPreferences(db, userId);
  const next = { ...current, ...changes };

  await db
    .insert(userPreferences)
    .values({ userId, ...next })
    .onConflictDoUpdate({
      target: userPreferences.userId,
      set: next,
    });

  return next;
}

// Minutos de aviso antes del partido que el usuario tiene activados
export function reminderMinutes(prefs: Preferences): number[] {
  const minutes: number[] = [];
  if (prefs.reminder60) minutes.push(60);
  if (prefs.reminder15) minutes.push(15);
  return minutes;
}
