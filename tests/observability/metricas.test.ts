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
  automatizacion: { automaticos: { A: 0, B: 0 }, manuales: 0, corregidos: 0, enEspera: 0, excluidos: 0 },
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
      // Jugado hace un día: empate sin quién pasó, en espera
      { ...base, id: "pm-sem", externalId: "t:sem", status: "finished", dateTime: new Date(AHORA.getTime() - DIA_MS) },
    ]);
    const ahora = AHORA.getTime();
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
      // El cruce manual y los que no terminaron no entran; pm-sem es adoptado, terminado y corregido a mano
      automatizacion: { automaticos: { A: 0, B: 0 }, manuales: 1, corregidos: 0, enEspera: 1, excluidos: 0 },
    });
    const json = JSON.stringify(prode);
    for (const dato of [user.id, other.id, "user-3", "g1", "Los pibes", "AAAA", "Ana", "eva@example.test"]) expect(json).not.toContain(dato);
  });

  it("cuenta como abiertos solo los partidos que todavía admiten pronósticos", async () => {
    await seedApp(t.db);
    const ahora = AHORA.getTime();
    const base = { homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league", dateTime: new Date(ahora + 1000) };
    await t.db.insert(matches).values([
      { ...base, id: "abierto", externalId: "t:abierto", status: "scheduled" },
      { ...base, id: "sin-estado", externalId: "t:sin-estado", status: null },
      { ...base, id: "postergado", externalId: "t:postergado", status: "postponed" },
      { ...base, id: "inicio-exacto", externalId: "t:inicio-exacto", status: "scheduled", dateTime: AHORA },
      { ...base, id: "cancelado", externalId: "t:cancelado", status: "cancelled" },
      { ...base, id: "en-juego", externalId: "t:en-juego", status: "live" },
      { ...base, id: "reanudado", externalId: "t:reanudado", status: "postponed" },
    ]);
    await t.db.insert(prodeMatches).values(
      ["abierto", "sin-estado", "postergado", "inicio-exacto", "cancelado", "en-juego", "reanudado"].map((matchId) => ({
        matchId, fase: "octavos", createdAt: AHORA, closedAt: matchId === "reanudado" ? ahora - 1000 : null,
      })),
    );

    const { prode } = await getMetricas(t.db, ahora);
    expect(prode.partidos).toEqual({ abiertos: 3, cerrados: 4, conResultado: 0 });
  });

  it("automatizacion: automáticos por regla, manuales, corregidos, en espera y excluidos, sin ids (docs/40 D5)", async () => {
    await seedApp(t.db);
    const H = DIA_MS / 24;
    const base = { homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league", dateTime: new Date(AHORA.getTime() - DIA_MS), status: "finished", source: "espn" };
    const auto = (local: number, visitante: number, pasa: string, regla: string) =>
      ({ autoHomeGoals90: local, autoAwayGoals90: visitante, autoPasa: pasa, autoRegla: regla, autoVistoAt: 1, autoConfirmadoAt: 2 });
    const casos: Array<[string, Partial<typeof prodeMatches.$inferInsert>, Partial<typeof matches.$inferInsert>?]> = [
      ["a1", auto(1, 0, "home", "A")],
      ["a2", auto(0, 2, "away", "A")],
      ["b1", auto(1, 1, "away", "B")],
      // Manual igual al automático: manual, no corregido
      ["man-igual", { ...auto(2, 0, "home", "A"), homeGoals90: 2, awayGoals90: 0 }],
      // Corregidos: otro marcador, otro equipo que pasó (con y sin marcador manual) y ganador manual contra quién pasa
      ["cor-goles", { ...auto(2, 0, "home", "A"), homeGoals90: 3, awayGoals90: 0 }],
      ["cor-pasa", { ...auto(1, 1, "away", "B"), pasa: "home" }],
      ["cor-pasa-goles", { ...auto(1, 1, "away", "B"), homeGoals90: 1, awayGoals90: 1, pasa: "home" }],
      ["cor-ganador", { autoPasa: "away", autoRegla: "B", autoVistoAt: 1, homeGoals90: 2, awayGoals90: 0 }],
      // Manual sin dato automático: manual, nada que corregir
      ["man-solo", { homeGoals90: 0, awayGoals90: 1 }],
      // En espera: sin nada, sin confirmar y empate sin quién pasó
      ["esp-vacio", {}],
      ["esp-sin-confirmar", { ...auto(1, 0, "home", "A"), autoConfirmadoAt: null }],
      ["esp-empate", { homeGoals90: 0, awayGoals90: 0 }],
      // Reciente (menos de 6 h): todavía no está en espera
      ["reciente", {}, { dateTime: new Date(AHORA.getTime() - 5 * H) }],
      ["x-excluido", { ...auto(1, 0, "home", "A"), homeGoals90: 4, awayGoals90: 0, excludedAt: 3 }],
      // Fuera del universo: sin terminar o cruce manual
      ["en-vivo", auto(1, 0, "home", "A"), { status: "live" }],
      ["cruce", {}, { source: "manual", homeScore: 1, awayScore: 0 }],
    ];
    for (const [id, vinculo, partido] of casos) {
      await t.db.insert(matches).values({ ...base, ...partido, id, externalId: `t:${id}` });
      await t.db.insert(prodeMatches).values({ matchId: id, fase: "octavos", createdAt: AHORA, ...vinculo });
    }
    const { prode } = await getMetricas(t.db, AHORA.getTime());
    expect(prode.automatizacion).toEqual({ automaticos: { A: 2, B: 1 }, manuales: 7, corregidos: 4, enEspera: 3, excluidos: 1 });
    // Con el automático apagado nada es automático y lo que dependía de él pasa a espera
    expect((await getMetricas(t.db, AHORA.getTime(), false)).prode.automatizacion).toMatchObject({ automaticos: { A: 0, B: 0 }, enEspera: 7, corregidos: 4 });
    const json = JSON.stringify(prode.automatizacion);
    for (const [id] of casos) expect(json).not.toContain(id);
  });

  it("conResultado cuenta un automático confirmado salvo que esté excluido o apagado (docs/40 D2 y D3)", async () => {
    await seedApp(t.db);
    const base = { homeTeamId: "river", awayTeamId: "boca", leagueId: "test-league", dateTime: new Date(AHORA.getTime() - DIA_MS), status: "finished", source: "espn" };
    await t.db.insert(matches).values([
      { ...base, id: "au-ok", externalId: "t:ok" }, { ...base, id: "au-sin", externalId: "t:sin" }, { ...base, id: "au-exc", externalId: "t:exc" },
    ]);
    const auto = { autoHomeGoals90: 1, autoAwayGoals90: 0, autoVistoAt: 1, createdAt: AHORA };
    await t.db.insert(prodeMatches).values([
      { matchId: "au-ok", fase: "octavos", ...auto, autoConfirmadoAt: 2 },
      { matchId: "au-sin", fase: "octavos", ...auto },
      { matchId: "au-exc", fase: "octavos", ...auto, autoConfirmadoAt: 2, excludedAt: 3 },
    ]);
    expect((await getMetricas(t.db, AHORA.getTime())).prode.partidos.conResultado).toBe(1);
    expect((await getMetricas(t.db, AHORA.getTime(), false)).prode.partidos.conResultado).toBe(0);
  });
});
