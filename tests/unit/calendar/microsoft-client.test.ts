import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createMicrosoftCalendarEvent,
  findMicrosoftEventByMatch,
  formatMatchForMicrosoft,
  listMicrosoftOverlaps,
  updateMicrosoftCalendarEvent,
} from "../../../src/lib/calendar/microsoft";

const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const llamada = (i = 0) => {
  const [url, init] = fetchMock.mock.calls[i] as [string, RequestInit];
  return { url: decodeURIComponent(url), method: init.method, body: init.body ? JSON.parse(init.body as string) : undefined };
};

const evento = formatMatchForMicrosoft("Boca", "River", "Liga", new Date("2026-10-25T20:00:00Z"), "Bombonera", [60, 15]);

beforeEach(() => vi.stubGlobal("fetch", fetchMock));
afterEach(() => {
  fetchMock.mockReset();
  vi.unstubAllGlobals();
});

describe("cliente de Microsoft Graph", () => {
  it("create manda transactionId y la propiedad extendida con el matchId", async () => {
    fetchMock.mockResolvedValue(json({ id: "e1", webLink: "" }));
    await createMicrosoftCalendarEvent("tok", {
      ...evento,
      transactionId: "tx-1",
      singleValueExtendedProperties: [
        { id: "String {00020329-0000-0000-C000-000000000046} Name fisture.matchId", value: "m1" },
      ],
    });
    const { body } = llamada();
    expect(body.transactionId).toBe("tx-1");
    expect(body.singleValueExtendedProperties[0].value).toBe("m1");
  });

  it("update usa PATCH con solo los campos propios (sin cuerpo ni recordatorio)", async () => {
    fetchMock.mockResolvedValue(json({ id: "e1", webLink: "" }));
    await updateMicrosoftCalendarEvent("tok", "e1", evento);
    const { method, body } = llamada();
    expect(method).toBe("PATCH");
    expect(Object.keys(body).sort()).toEqual(["end", "location", "start", "subject"]);
  });

  it("findMicrosoftEventByMatch filtra por la propiedad extendida y devuelve el id o null", async () => {
    fetchMock.mockResolvedValueOnce(json({ value: [{ id: "e9" }] }));
    expect(await findMicrosoftEventByMatch("tok", "m1")).toBe("e9");
    const { url } = llamada();
    expect(url).toContain("singleValueExtendedProperties/Any");
    expect(url).toContain("m1");
    fetchMock.mockResolvedValueOnce(json({ value: [] }));
    expect(await findMicrosoftEventByMatch("tok", "m1")).toBeNull();
  });

  it("listMicrosoftOverlaps excluye el propio, los cancelados y los de todo el día", async () => {
    const t = (h: number) => ({ dateTime: `2026-10-25T${h}:00:00` });
    fetchMock.mockResolvedValue(
      json({
        value: [
          { id: "propio", subject: "Boca vs River", isAllDay: false, isCancelled: false, start: t(20), end: t(22) },
          { id: "a", subject: "Reunión", isAllDay: false, isCancelled: false, start: t(19), end: t(21) },
          { id: "b", subject: "Cancelada", isAllDay: false, isCancelled: true, start: t(20), end: t(21) },
          { id: "c", subject: "Cumple", isAllDay: true, isCancelled: false, start: t(0), end: t(0) },
        ],
      })
    );
    const r = await listMicrosoftOverlaps("tok", new Date("2026-10-25T20:00:00Z"), new Date("2026-10-25T22:00:00Z"), "propio");
    expect(r.map((x) => x.title)).toEqual(["Reunión"]);
  });
});
