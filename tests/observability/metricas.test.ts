import { describe, expect, it } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { seedApp } from "../helpers/fixtures";
import { AHORA, DIA_MS } from "../helpers/clock";
import { calendarSyncs, userTeams, users } from "../../drizzle/schema";
import { getMetricas } from "../../src/lib/observability/metricas";

describe("getMetricas", () => {
  const t = useTestDb();

  it("con la base vacía todo es cero", async () => {
    expect(await getMetricas(t.db, AHORA.getTime())).toEqual({
      usuarios: 0,
      registrosUltimos7Dias: 0,
      registrosUltimos30Dias: 0,
      usuariosConEquipos: 0,
      usuariosConPartidos: 0,
      eventosEnCalendarios: 0,
      equiposSeguidos: 0,
    });
  });

  it("cuenta registros por ventana, seguidores y eventos sincronizados", async () => {
    const { user } = await seedApp(t.db);
    // seedApp crea dos usuarios con created_at = hora real de D1; uno de hace 40 días queda fuera de las ventanas
    await t.db.insert(users).values({ id: "viejo", provider: "google", providerId: "p-viejo", email: "viejo@example.test", createdAt: new Date(Date.now() - 40 * DIA_MS) });
    await t.db.insert(userTeams).values([
      { userId: user.id, teamId: "river" },
      { userId: user.id, teamId: "boca" },
      { userId: "viejo", teamId: "river" },
    ]);
    await t.db.insert(calendarSyncs).values([
      { userId: user.id, matchId: "superclasico", provider: "google", status: "synced" },
      { userId: "viejo", matchId: "superclasico", provider: "google", status: "detached" },
    ]);

    expect(await getMetricas(t.db, Date.now() + 60_000)).toEqual({
      usuarios: 3,
      registrosUltimos7Dias: 2,
      registrosUltimos30Dias: 2,
      usuariosConEquipos: 2,
      usuariosConPartidos: 1,
      eventosEnCalendarios: 1,
      equiposSeguidos: 3,
    });
  });
});
