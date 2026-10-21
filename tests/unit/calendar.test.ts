import { afterEach, describe, expect, it, vi } from "vitest";
import { generateICS, generateSingleEventICS } from "../../src/lib/calendar/ics";
import { formatMatchForGoogle, createGoogleCalendarEvent, updateGoogleCalendarEvent, deleteGoogleCalendarEvent } from "../../src/lib/calendar/google";
import { formatMatchForMicrosoft, createMicrosoftCalendarEvent, updateMicrosoftCalendarEvent, deleteMicrosoftCalendarEvent } from "../../src/lib/calendar/microsoft";
import { DEFAULT_PREFERENCES, reminderMinutes } from "../../src/lib/db/preferences";

afterEach(() => vi.useRealTimers());

it("exporta ICS en UTC, con UID estable, escapes y recordatorios", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
  const content = generateICS([{
    id: "match-1", title: "River; Boca, final\\copa\nHoy",
    description: "Liga\nArgentina", location: "Estadio, Sur",
    startTime: new Date("2026-10-22T00:00:00Z"), endTime: new Date("2026-10-22T02:00:00Z"),
  }], { reminderMinutes: [60, 15] });
  expect(content).toContain("UID:match-1@fisture.app\r\n");
  expect(content).toContain("DTSTART:20261022T000000Z");
  expect(content).toContain("DTEND:20261022T020000Z");
  expect(content).toContain("SUMMARY:River\\; Boca\\, final\\\\copa\\nHoy");
  expect(content).toContain("LOCATION:Estadio\\, Sur");
  expect(content).toContain("TRIGGER:-PT60M");
  expect(content).toContain("TRIGGER:-PT15M");
  expect(content).toContain("DESCRIPTION:Liga\\nArgentina");
});

it("exporta calendarios vacíos y eventos sin avisos opcionales", () => {
  expect(generateICS([])).not.toContain("BEGIN:VEVENT");
  expect(generateSingleEventICS({ id: "x", title: "Partido", startTime: new Date(), endTime: new Date() })).not.toContain("VALARM");
  expect(reminderMinutes(DEFAULT_PREFERENCES)).toEqual([60, 15]);
  expect(reminderMinutes({ reminder60: false, reminder15: true, theme: "papel" })).toEqual([15]);
  expect(reminderMinutes({ reminder60: false, reminder15: false, theme: "papel" })).toEqual([]);
});

it("formatea eventos Google con dos horas y avisos configurados", () => {
  const event = formatMatchForGoogle("River", "Boca", "Liga", new Date("2026-10-21T23:00:00Z"), null, [60, 15]);
  expect(event.summary).toBe("River vs Boca");
  expect(event.start.dateTime).toBe("2026-10-21T23:00:00.000Z");
  expect(event.end.dateTime).toBe("2026-10-22T01:00:00.000Z");
  expect(event.reminders?.overrides?.map((r) => r.minutes)).toEqual([60, 15]);
  expect(event.location).toBeUndefined();
});

it("formatea Microsoft con UTC explícito y el aviso más anticipado", () => {
  const event = formatMatchForMicrosoft("River", "Boca", "Liga", new Date("2026-10-21T23:00:00Z"), "Monumental", [15, 60]);
  expect(event.subject).toBe("River vs Boca");
  expect(event.start).toEqual({ dateTime: "2026-10-21T23:00:00.000", timeZone: "UTC" });
  expect(event.end.dateTime).toBe("2026-10-22T01:00:00.000");
  expect(event.reminderMinutesBeforeStart).toBe(60);
  expect(event.location?.displayName).toBe("Monumental");
  const noReminder = formatMatchForMicrosoft("A", "B", "L", new Date(), null, []);
  expect(noReminder.isReminderOn).toBe(false);
  expect(noReminder.location).toBeUndefined();
});

describe.each([
  { provider: "Google", create: createGoogleCalendarEvent, update: updateGoogleCalendarEvent, remove: deleteGoogleCalendarEvent, method: "PUT", event: () => formatMatchForGoogle("A", "B", "L", new Date(), null, []) },
  { provider: "Microsoft", create: createMicrosoftCalendarEvent, update: updateMicrosoftCalendarEvent, remove: deleteMicrosoftCalendarEvent, method: "PATCH", event: () => formatMatchForMicrosoft("A", "B", "L", new Date(), null, []) },
])("contrato HTTP de $provider", ({ create, update, remove, method, event }) => {
  it("envía método, autorización y payload", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    const fetch = vi.fn().mockImplementation(async () => Response.json({ id: "external-1" }));
    vi.stubGlobal("fetch", fetch);
    await create("test-token", event() as never);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: "POST", headers: { Authorization: "Bearer test-token" } });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual(event());
    await update("test-token", "external-1", event() as never);
    expect(fetch.mock.calls[1][1].method).toBe(method);
    expect(fetch.mock.calls[1][0]).toContain("external-1");
    await remove("test-token", "external-1");
    expect(fetch.mock.calls[2][1].method).toBe("DELETE");
  });
  it("propaga errores y tolera eliminar un evento inexistente", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => Response.json({ error: { message: "Quota exceeded" } }, { status: 429 })));
    await expect(create("t", event() as never)).rejects.toThrow("Quota exceeded");
    await expect(update("t", "id", event() as never)).rejects.toThrow("Quota exceeded");
    await expect(remove("t", "id")).rejects.toThrow("Quota exceeded");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(remove("t", "id")).resolves.toBeUndefined();
  });
});
