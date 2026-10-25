import { afterEach, describe, expect, it, vi } from "vitest";
import scoreboard from "../fixtures/espn-scoreboard.json";
import { aniosATraer, createEspnClient } from "../../src/lib/data-providers/espn";

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
