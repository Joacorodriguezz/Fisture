import { afterEach, describe, expect, it, vi } from "vitest";
import scoreboard from "../fixtures/espn-scoreboard.json";
import { aniosATraer, createEspnClient, partirEtapa } from "../../src/lib/data-providers/espn";

afterEach(() => vi.useRealTimers());

const payload = () => structuredClone(scoreboard);
function mockResponse(data: unknown, status = 200) {
  const fetch = vi.fn().mockImplementation(async () => Response.json(data, { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

it("pide los años que completan la temporada europea", () => {
  expect(aniosATraer(new Date("2026-07-31T23:00:00Z"))).toEqual([2025, 2026]);
  expect(aniosATraer(new Date("2026-08-01T00:00:00Z"))).toEqual([2026, 2027]);
});

describe("contrato ESPN con fixture sin red", () => {
  it("normaliza IDs, local/visitante y elimina duplicados entre años", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    const fetch = mockResponse(payload());
    const fixture = await createEspnClient().getFixture!("arg.1", { years: [2025, 2026] });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fixture.matches).toHaveLength(1);
    expect(fixture.matches[0]).toMatchObject({ externalId: "espn:1", homeTeamExternalId: "espn:16", awayTeamExternalId: "espn:5", status: "scheduled", homeScore: null, venue: "Monumental" });
    expect(fixture.matches[0].round).toContain("Fecha 1");
    expect(fixture.teams).toHaveLength(2);
    expect(fixture.participantIds).toEqual(expect.arrayContaining(["espn:16", "espn:5"]));
  });
  it.each([
    ["STATUS_IN_PROGRESS", "in", "live"], ["STATUS_FINAL", "post", "finished"],
    ["STATUS_POSTPONED", "pre", "postponed"], ["STATUS_CANCELED", "post", "cancelled"],
  ])("mapea %s y mantiene el marcador solo cuando corresponde", async (name, state, status) => {
    const data = payload();
    data.events[0].status.type = { name, state };
    data.events[0].competitions[0].competitors[1].score = "2";
    mockResponse(data);
    const { matches } = await createEspnClient().getFixture!("arg.1", { years: [2026] });
    expect(matches[0].status).toBe(status);
    expect(matches[0].homeScore).toBe(["live", "finished"].includes(status) ? 2 : null);
  });
  it("descarta equipos placeholder y competencias incompletas", async () => {
    const data = payload();
    data.events[0].competitions[0].competitors[0].team.displayName = "TBD Away";
    mockResponse(data);
    expect((await createEspnClient().getFixture!("arg.1", { years: [2026] })).matches).toEqual([]);
    data.events[0].competitions[0].competitors = [];
    mockResponse(data);
    expect((await createEspnClient().getFixture!("arg.1", { years: [2026] })).matches).toEqual([]);
  });
  it("acepta años sin calendario y respuestas vacías", async () => {
    mockResponse({}, 400);
    expect((await createEspnClient().getFixture!("arg.1", { years: [2026] })).matches).toEqual([]);
    mockResponse({});
    expect((await createEspnClient().getFixture!("arg.1", { years: [2026] })).teams).toEqual([]);
  });
  it("reintenta tres veces ante errores del proveedor y luego informa el fallo", async () => {
    vi.useFakeTimers();
    const fetch = mockResponse({}, 503);
    const operation = expect(createEspnClient().getFixture!("arg.1", { years: [2026] })).rejects.toThrow("HTTP 503");
    await vi.runAllTimersAsync();
    await operation;
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

// docs/32 D8: etapas de las ligas sudamericanas nuevas
describe("rondas de las ligas sudamericanas (docs/32)", () => {
  const evento = (id: string, slug: string, visitante: string, fecha: string) => ({
    ...structuredClone(scoreboard.events[0]),
    id,
    date: fecha,
    season: { year: 2026, slug },
    competitions: [{ venue: { fullName: "Cancha" }, competitors: [
      { homeAway: "home", score: "0", team: { id: "1", displayName: "Equipo 1", abbreviation: "E1" } },
      { homeAway: "away", score: "0", team: { id: visitante, displayName: `Equipo ${visitante}`, abbreviation: `E${visitante}` } },
    ] }],
  });
  // Dos partidos del mismo equipo: el segundo es "Fecha 2" si la etapa numera
  const rondas = async (liga: string, slug: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    mockResponse({ events: [evento("1", slug, "2", "2026-10-22T00:00:00Z"), evento("2", slug, "3", "2026-10-29T00:00:00Z")] });
    const { matches } = await createEspnClient().getFixture!(liga, { years: [2026] });
    return matches.map((m) => m.round);
  };

  it.each([
    ["uru.1", "torneo-intermedio", ["Torneo Intermedio · Fecha 1", "Torneo Intermedio · Fecha 2"]],
    ["uru.1", "intermedio-final", ["Torneo Intermedio · Final", "Torneo Intermedio · Final"]],
    ["col.1", "apertura", ["Apertura · Fecha 1", "Apertura · Fecha 2"]],
    ["col.1", "clausura", ["Clausura · Fecha 1", "Clausura · Fecha 2"]],
    ["ven.1", "apertura-quadrangular", ["Apertura · Cuadrangular · Fecha 1", "Apertura · Cuadrangular · Fecha 2"]],
    ["ven.1", "clausura-quadrangular", ["Clausura · Cuadrangular · Fecha 1", "Clausura · Cuadrangular · Fecha 2"]],
    ["ven.1", "apertura-final", ["Apertura · Final", "Apertura · Final"]],
    ["ecu.1", "first-stage", ["Primera fase · Fecha 1", "Primera fase · Fecha 2"]],
    ["ecu.1", "final-stage", ["Fase final · Fecha 1", "Fase final · Fecha 2"]],
    ["par.1", "torneo-apertura-2026", ["Apertura · Fecha 1", "Apertura · Fecha 2"]],
    ["par.1", "torneo-clausura-2026", ["Clausura · Fecha 1", "Clausura · Fecha 2"]],
    ["col.copa", "group-stage1a", ["Fase de grupos · Fecha 1", "Fase de grupos · Fecha 2"]],
    ["col.copa", "stage-1b", ["Fase 1B", "Fase 1B"]],
    ["chi.1", "2026-primera-division-de-chile", ["Fecha 1", "Fecha 2"]],
  ])("%s %s", async (liga, slug, esperado) => {
    expect(await rondas(liga, slug)).toEqual(esperado);
  });

  it("first-stage no numera fechas en las copas (regresión)", async () => {
    expect(await rondas("conmebol.libertadores", "first-stage")).toEqual(["Primera fase", "Primera fase"]);
  });

  it("normaliza el sufijo de año de la etapa", () => {
    expect(partirEtapa("torneo-apertura-2026")).toEqual({ torneo: null, etapa: "torneo-apertura" });
    expect(partirEtapa("torneo-clausura-2027")).toEqual({ torneo: null, etapa: "torneo-clausura" });
    expect(partirEtapa("2025-argentine-trofeo-de-campeones---final")).toEqual({ torneo: null, etapa: "final" });
  });
});
