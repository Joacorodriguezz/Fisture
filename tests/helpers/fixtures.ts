import { leagues, teams, matches, users, leagueTeams } from "../../drizzle/schema";
import type { Database } from "../../src/lib/db";
import { AHORA, DIA_MS, HORA_MS } from "./clock";

// Entorno vacío tipado: los servicios con clientes/tokens falsos no leen variables de entorno
export const ENV_VACIO = {} as Env;

// Base de los tests de integración con D1 real. Las fechas son relativas a AHORA (ver clock.ts).
// Para los tests con cliente de calendario falso se usa helpers/calendar.ts (sembrar), que
// modela otro escenario: usuarios u1/u2 y partidos m1..m3 en una fecha fija.
export async function seedApp(db: Database, ahora: Date = AHORA) {
  await db.insert(leagues).values({ id: "test-league", externalId: "test:league", name: "Liga de prueba", country: "Argentina", season: 2026 });
  await db.insert(teams).values([
    { id: "river", externalId: "test:river", name: "River Plate", shortName: "RIV", leagueId: "test-league" },
    { id: "boca", externalId: "test:boca", name: "Boca Juniors", shortName: "BOC", leagueId: "test-league" },
  ]);
  await db.insert(leagueTeams).values([{ leagueId: "test-league", teamId: "river" }, { leagueId: "test-league", teamId: "boca" }]);
  await db.insert(matches).values({ id: "superclasico", externalId: "test:match", homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league", dateTime: new Date(ahora.getTime() + DIA_MS), venue: "Monumental", status: "scheduled" });
  const [user, other] = await db.insert(users).values([
    { id: "user-1", provider: "google", providerId: "provider-1", email: "ana@example.test", name: "Ana", accessToken: "test-token", tokenExpiresAt: ahora.getTime() + HORA_MS },
    { id: "user-2", provider: "microsoft", providerId: "provider-2", email: "luis@example.test", name: "Luis", accessToken: "test-token", tokenExpiresAt: ahora.getTime() + HORA_MS },
  ]).returning();
  return { user, other };
}
