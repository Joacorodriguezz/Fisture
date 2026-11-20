// Puntaje del prode dentro del sync (docs/37 §3.5): corre donde corren los chequeos de consistencia
// (sin lotes, con leagueId o en el último lote), con una sola subrequest, y un fallo no tumba el sync.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { AHORA, relojFijo } from "../helpers/clock";
import { pronosticoDirecto, sembrarProde } from "../helpers/prode";
import { createLogger } from "../../src/lib/observability/logger";
import { runSync, type RunSyncDeps } from "../../src/lib/observability/run-sync";

const res = (league: string) => ({ league, source: "espn", teamsCreated: 0, teamsUpdated: 0, matchesCreated: 0, matchesUpdated: 0, matchesSkipped: 0, errors: [] });

describe("runSync: puntaje del prode", () => {
  const t = useTestDb();
  relojFijo();
  let lineas: { level: string; data: Record<string, unknown> }[];
  let logger: ReturnType<typeof createLogger>;

  const deps = (over: Partial<RunSyncDeps> = {}): RunSyncDeps => ({
    syncAllLeagues: async () => [res("Liga A")],
    syncSingleLeague: async (_e, id) => res(id),
    syncLote: async (_e, n) => ({ lote: n, totalLotes: 3, siguienteLote: n < 2 ? n + 1 : null, results: [res("Liga A")] }),
    ...over,
  });
  const eventos = (msg: string) => lineas.filter((l) => l.data.msg === msg);

  beforeEach(async () => {
    lineas = [];
    logger = createLogger({ write: (level, line) => lineas.push({ level, data: JSON.parse(line) }) });
    await sembrarProde(t.DB);
    await pronosticoDirecto(t.DB, "ana", "terminado-1", 2, 1);
    await pronosticoDirecto(t.DB, "beto", "terminado-1", 0, 1);
  });

  const puntos = async (userId: string) =>
    (await t.DB.prepare("SELECT points FROM prode_predictions WHERE user_id = ?1 AND match_id = 'terminado-1'").bind(userId).first<{ points: number | null }>())?.points;

  it("sin lotes puntúa y loguea solo los conteos", async () => {
    const r = await runSync({ DB: t.DB }, "admin", { deps: deps(), logger });
    expect(r.status).not.toBe("failed");
    expect([await puntos("ana"), await puntos("beto")]).toEqual([3, 0]);
    expect(eventos("prode_scored").map((l) => l.data)).toEqual([expect.objectContaining({ puntuados: 2, anulados: 0 })]);
    expect(JSON.stringify(eventos("prode_scored"))).not.toMatch(/ana|beto|terminado/);
  });

  it("con leagueId también puntúa", async () => {
    await runSync({ DB: t.DB }, "admin", { leagueId: "arg.1", deps: deps(), logger });
    expect(await puntos("ana")).toBe(3);
  });

  it("un lote intermedio no puntúa; el último sí", async () => {
    await runSync({ DB: t.DB }, "admin", { lote: 0, deps: deps(), logger });
    expect(await puntos("ana")).toBeNull();
    expect(eventos("prode_scored")).toEqual([]);
    await runSync({ DB: t.DB }, "admin", { lote: 2, deps: deps(), logger });
    expect(await puntos("ana")).toBe(3);
  });

  it("si el puntaje falla, el sync termina bien y deja un aviso", async () => {
    const llamadas: unknown[][] = [];
    const puntuarPronosticos = vi.fn(async (...args: unknown[]) => {
      llamadas.push(args);
      throw new Error("D1 caída");
    });
    const r = await runSync({ DB: t.DB }, "admin", { deps: deps({ puntuarPronosticos }), logger });
    // Se compara por identidad: la D1 de Miniflare no se puede inspeccionar
    expect(llamadas).toHaveLength(1);
    expect(llamadas[0][0] === t.DB).toBe(true);
    expect(llamadas[0][1]).toEqual(AHORA);
    expect(r.status).not.toBe("failed");
    expect(eventos("prode_scoring_failed").map((l) => l.level)).toEqual(["warn"]);
  });
});
