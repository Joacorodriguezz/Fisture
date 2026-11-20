import { describe, expect, it } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { seedApp } from "../helpers/fixtures";
import { AHORA, DIA_MS } from "../helpers/clock";
import { calendarSyncs, matches, prodeGroupMembers, prodeGroups, prodeMatches, prodePredictions, userTeams, users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { getMetricas } from "../../src/lib/observability/metricas";

const PRODE_CERO = {
  gruposCreados: 0,
  participantes: 0,
  participantesPorFase: { octavos: 0, cuartos: 0, semifinal: 0, final: 0 },
  regresanPorFase: { octavos: 0, cuartos: 0, semifinal: 0, final: 0 },
  integrantesPorGrupo: { promedio: 0, maximo: 0 },
  partidos: { abiertos: 0, cerrados: 0, conResultado: 0 },
  pronosticos: 0,
};

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
      calendariosSinAcceso: 0,
      prode: PRODE_CERO,
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
    await t.db.update(users).set({ calendarAuthStatus: "reauth_required" }).where(eq(users.id, "viejo"));
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
      calendariosSinAcceso: 1,
      prode: PRODE_CERO,
    });
  });

  it("agrega las métricas del prode sin ids ni nombres", async () => {
    const { user, other } = await seedApp(t.db);
    const base = { homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league", dateTime: new Date(AHORA.getTime() + DIA_MS) };
    await t.db.insert(users).values({ id: "user-3", provider: "google", providerId: "p3", email: "eva@example.test", name: "Eva" });
    await t.db.insert(matches).values([
      { ...base, id: "pm-oct", externalId: "t:oct", status: "finished", source: "manual", homeScore: 1, awayScore: 0 },
      { ...base, id: "pm-cua", externalId: "t:cua", status: "scheduled" },
      { ...base, id: "pm-sem", externalId: "t:sem", status: "finished" },
    ]);
    const ahora = Date.now();
    await t.db.insert(prodeMatches).values([
      { matchId: "pm-oct", fase: "octavos", createdAt: new Date(ahora), closedAt: ahora },
      { matchId: "pm-cua", fase: "cuartos", createdAt: new Date(ahora) },
      { matchId: "pm-sem", fase: "semifinal", createdAt: new Date(ahora), closedAt: ahora, homeGoals90: 1, awayGoals90: 1 },
    ]);
    const p = (userId: string, matchId: string) => ({ userId, matchId, homeGoals: 1, awayGoals: 0, createdAt: new Date(ahora), updatedAt: new Date(ahora) });
    await t.db.insert(prodePredictions).values([
      p(user.id, "pm-oct"), p(user.id, "pm-cua"), p(user.id, "pm-sem"),
      p(other.id, "pm-oct"), p(other.id, "pm-cua"),
      p("user-3", "pm-cua"),
    ]);
    await t.db.insert(prodeGroups).values([
      { id: "g1", name: "Los pibes", inviteCode: "AAAA", ownerId: user.id, createdAt: ahora },
      { id: "g2", name: "Oficina", inviteCode: "BBBB", ownerId: other.id, createdAt: ahora },
    ]);
    await t.db.insert(prodeGroupMembers).values([
      { groupId: "g1", userId: user.id, joinedAt: ahora }, { groupId: "g1", userId: other.id, joinedAt: ahora }, { groupId: "g1", userId: "user-3", joinedAt: ahora },
      { groupId: "g2", userId: other.id, joinedAt: ahora },
    ]);

    const { prode } = await getMetricas(t.db, ahora);
    expect(prode).toEqual({
      gruposCreados: 2,
      participantes: 3,
      participantesPorFase: { octavos: 2, cuartos: 3, semifinal: 1, final: 0 },
      // cuartos: user-1 y user-2 ya habían jugado octavos, user-3 es nuevo; semifinal: user-1 viene de antes
      regresanPorFase: { octavos: 0, cuartos: 2, semifinal: 1, final: 0 },
      integrantesPorGrupo: { promedio: 2, maximo: 3 },
      partidos: { abiertos: 1, cerrados: 2, conResultado: 2 },
      pronosticos: 6,
    });
    const json = JSON.stringify(prode);
    for (const dato of [user.id, other.id, "user-3", "g1", "Los pibes", "AAAA", "Ana", "eva@example.test"]) expect(json).not.toContain(dato);
  });
});
