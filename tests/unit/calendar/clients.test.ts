import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClient, type MatchDetail } from "../../../src/lib/calendar/clients";
import { fistureEventId } from "../../../src/lib/calendar/event-id";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const llamada = (i: number) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit | undefined];
  return { url: decodeURIComponent(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body as string) : undefined };
};

const prefs = { reminder60: true, reminder15: true, theme: "papel" as const };
const partido = (status = "scheduled") =>
  ({
    match: { id: "m1", dateTime: new Date("2026-10-25T20:00:00Z"), venue: "Bombonera", status },
    homeTeam: { name: "Boca" },
    awayTeam: { name: "River" },
    league: { name: "Liga" },
  }) as unknown as MatchDetail;

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("cliente Google (idempotencia)", () => {
  it("crea con el id determinístico y la etiqueta del partido", async () => {
    const id = await fistureEventId("u1", "m1");
    fetchMock.mockResolvedValueOnce(json({ id, htmlLink: "" }));
    expect(await getClient("google").create("tok", partido(), prefs, { userId: "u1" })).toBe(id);
    expect(llamada(0).body).toMatchObject({ id, summary: "Boca vs River", extendedProperties: { private: { fisture: "m1" } } });
  });

  it("409 con el evento vivo: lo adopta y lo actualiza, sin crear otro", async () => {
    const id = await fistureEventId("u1", "m1");
    fetchMock
      .mockResolvedValueOnce(json({ error: { message: "exists" } }, 409))
      .mockResolvedValueOnce(json({ id, status: "confirmed" }))
      .mockResolvedValueOnce(json({ id, htmlLink: "" }));
    expect(await getClient("google").create("tok", partido(), prefs, { userId: "u1" })).toBe(id);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(llamada(2)).toMatchObject({ method: "PATCH" });
    expect(llamada(2).body.status).toBeUndefined();
  });

  it("A9: 409 con el evento cancelado (borrado antes): lo restaura", async () => {
    const id = await fistureEventId("u1", "m1");
    fetchMock
      .mockResolvedValueOnce(json({ error: { message: "exists" } }, 409))
      .mockResolvedValueOnce(json({ id, status: "cancelled" }))
      .mockResolvedValueOnce(json({ id, htmlLink: "" }));
    await getClient("google").create("tok", partido(), prefs, { userId: "u1" });
    expect(llamada(2).body.status).toBe("confirmed");
  });

  it("409 pero el evento no se encuentra: propaga el conflicto", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { message: "exists" } }, 409)).mockResolvedValueOnce(json({}, 404));
    await expect(getClient("google").create("tok", partido(), prefs, { userId: "u1" })).rejects.toMatchObject({ status: 409 });
  });

  it("un postergado se crea con el prefijo en el título", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "x", htmlLink: "" }));
    await getClient("google").create("tok", partido("postponed"), prefs, { userId: "u1" });
    expect(llamada(0).body.summary).toBe("[POSTERGADO] Boca vs River");
  });

  it("overlaps consulta la franja del partido (2 h) y excluye el evento propio", async () => {
    fetchMock.mockResolvedValueOnce(json({ items: [] }));
    await getClient("google").overlaps("tok", partido(), "evx");
    const { url } = llamada(0);
    expect(url).toContain("timeMin=2026-10-25T20:00:00.000Z");
    expect(url).toContain("timeMax=2026-10-25T22:00:00.000Z");
  });
});

describe("cliente Microsoft (idempotencia)", () => {
  it("sin evento previo: busca por la etiqueta y crea con transactionId", async () => {
    fetchMock.mockResolvedValueOnce(json({ value: [] })).mockResolvedValueOnce(json({ id: "AAA", webLink: "" }));
    expect(await getClient("microsoft").create("tok", partido(), prefs, { userId: "u1" })).toBe("AAA");
    expect(llamada(0).url).toContain("fisture.matchId");
    const crear = llamada(1);
    expect(crear.method).toBe("POST");
    expect(crear.body.transactionId).toBeTruthy();
    expect(crear.body.singleValueExtendedProperties[0].value).toBe("m1");
  });

  it("con un evento previo etiquetado: lo adopta y lo actualiza, sin crear otro", async () => {
    fetchMock.mockResolvedValueOnce(json({ value: [{ id: "BBB" }] })).mockResolvedValueOnce(json({ id: "BBB", webLink: "" }));
    expect(await getClient("microsoft").create("tok", partido(), prefs, { userId: "u1" })).toBe("BBB");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(llamada(1).method).toBe("PATCH");
  });
});

describe("proveedor no soportado", () => {
  it("lanza un error claro", () => {
    expect(() => getClient("apple")).toThrow("Proveedor de calendario no soportado");
  });
});
