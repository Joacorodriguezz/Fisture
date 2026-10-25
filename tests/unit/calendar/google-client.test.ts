import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createGoogleCalendarEvent,
  formatMatchForGoogle,
  getGoogleCalendarEvent,
  listGoogleOverlaps,
  restoreGoogleCalendarEvent,
  updateGoogleCalendarEvent,
} from "../../../src/lib/calendar/google";
import { CalendarApiError } from "../../../src/lib/calendar/errors";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const llamada = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url, method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
};

const evento = formatMatchForGoogle("Boca", "River", "Liga", new Date("2026-10-25T20:00:00Z"), "Bombonera", [60, 15]);

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("cliente de Google Calendar", () => {
  it("update usa PATCH y manda solo los campos propios (sin recordatorios ni descripción)", async () => {
    fetchMock.mockResolvedValue(json({ id: "e1", htmlLink: "" }));
    await updateGoogleCalendarEvent("tok", "e1", evento);
    const { method, body, url } = llamada();
    expect(method).toBe("PATCH");
    expect(url).toContain("/events/e1");
    expect(Object.keys(body).sort()).toEqual(["end", "location", "start", "summary"]);
  });

  it("create manda el id elegido por nosotros y lo devuelve", async () => {
    fetchMock.mockResolvedValue(json({ id: "fxabc", htmlLink: "" }));
    const r = await createGoogleCalendarEvent("tok", { ...evento, id: "fxabc" });
    expect(llamada().body.id).toBe("fxabc");
    expect(r.id).toBe("fxabc");
  });

  it("create con id repetido (409) se lanza como CalendarApiError 409", async () => {
    fetchMock.mockResolvedValue(json({ error: { message: "identifier already exists" } }, 409));
    await expect(createGoogleCalendarEvent("tok", { ...evento, id: "fxabc" })).rejects.toMatchObject({ status: 409 });
  });

  it("restaurar manda status confirmed junto con los campos propios", async () => {
    fetchMock.mockResolvedValue(json({ id: "e1", htmlLink: "" }));
    await restoreGoogleCalendarEvent("tok", "e1", evento);
    const { method, body } = llamada();
    expect(method).toBe("PATCH");
    expect(body.status).toBe("confirmed");
    expect(body.summary).toBe("Boca vs River");
  });

  it("getGoogleCalendarEvent devuelve null si no existe (404) y el estado si existe", async () => {
    fetchMock.mockResolvedValueOnce(json({}, 404));
    expect(await getGoogleCalendarEvent("tok", "e1")).toBeNull();
    fetchMock.mockResolvedValueOnce(json({ id: "e1", status: "cancelled" }));
    expect(await getGoogleCalendarEvent("tok", "e1")).toEqual({ id: "e1", status: "cancelled" });
  });

  it("un error de la API llega como CalendarApiError con su status", async () => {
    fetchMock.mockResolvedValue(json({ error: { message: "backend" } }, 503));
    const err = await updateGoogleCalendarEvent("tok", "e1", evento).catch((e) => e);
    expect(err).toBeInstanceOf(CalendarApiError);
    expect(err.status).toBe(503);
  });

  it("listGoogleOverlaps excluye el evento propio, los cancelados y los de todo el día; máx. 3", async () => {
    const hs = (h: number) => ({ dateTime: `2026-10-25T${h}:00:00Z` });
    fetchMock.mockResolvedValue(
      json({
        items: [
          { id: "propio", summary: "Boca vs River", start: hs(20), end: hs(22) },
          { id: "a", summary: "Reunión", start: hs(19), end: hs(21) },
          { id: "b", summary: "Cancelada", status: "cancelled", start: hs(20), end: hs(21) },
          { id: "c", summary: "Cumple", start: { date: "2026-10-25" }, end: { date: "2026-10-26" } },
          { id: "d", summary: "Cena", start: hs(21), end: hs(23) },
          { id: "e", summary: "Otro 1", start: hs(21), end: hs(23) },
          { id: "f", summary: "Otro 2", start: hs(21), end: hs(23) },
        ],
      })
    );
    const r = await listGoogleOverlaps("tok", new Date("2026-10-25T20:00:00Z"), new Date("2026-10-25T22:00:00Z"), "propio");
    expect(r.map((x) => x.title)).toEqual(["Reunión", "Cena", "Otro 1"]);
    expect(llamada().url).toContain("singleEvents=true");
  });
});
