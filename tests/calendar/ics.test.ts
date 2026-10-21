import { describe, expect, it } from "vitest";
import { generateICS } from "../../src/lib/calendar/ics";
import { matchToIcsEvent } from "../../src/lib/calendar/ics-match";

const partido = (o: { status?: string; updatedAt?: Date | null; dateTime?: Date } = {}) =>
  matchToIcsEvent(
    {
      id: "m1",
      dateTime: o.dateTime ?? new Date("2026-10-25T20:00:00Z"),
      venue: "Bombonera",
      status: o.status ?? "scheduled",
      updatedAt: o.updatedAt === undefined ? new Date("2026-10-20T10:00:00Z") : o.updatedAt,
    },
    "Boca",
    "River",
    "Liga"
  );

describe("matchToIcsEvent + generateICS", () => {
  it("A7: el UID es estable entre dos generaciones", () => {
    const uid = (ics: string) => ics.match(/UID:(.*)\r?\n/)?.[1];
    expect(uid(generateICS([partido()]))).toBe(uid(generateICS([partido()])));
    expect(uid(generateICS([partido()]))).toBe("m1@fisture.app");
  });

  it("A7: el SEQUENCE crece cuando el partido cambia (updated_at)", () => {
    const seq = (ics: string) => Number(ics.match(/SEQUENCE:(\d+)/)?.[1]);
    const antes = seq(generateICS([partido({ updatedAt: new Date("2026-10-20T10:00:00Z") })]));
    const despues = seq(generateICS([partido({ updatedAt: new Date("2026-10-21T10:00:00Z") })]));
    expect(despues).toBeGreaterThan(antes);
  });

  it("un partido reprogramado cambia DTSTART con el mismo UID", () => {
    const a = generateICS([partido()]);
    const b = generateICS([partido({ dateTime: new Date("2026-10-26T20:00:00Z") })]);
    expect(a).toContain("DTSTART:20261025T200000Z");
    expect(b).toContain("DTSTART:20261026T200000Z");
    expect(b).toContain("UID:m1@fisture.app");
  });

  it("un cancelado lleva STATUS:CANCELLED y uno normal STATUS:CONFIRMED", () => {
    expect(generateICS([partido({ status: "cancelled" })])).toContain("STATUS:CANCELLED");
    expect(generateICS([partido()])).toContain("STATUS:CONFIRMED");
  });

  it("un postergado lleva el prefijo en el SUMMARY", () => {
    expect(generateICS([partido({ status: "postponed" })])).toContain("SUMMARY:[POSTERGADO] Boca vs River");
  });

  it("live y finished se tratan como un partido normal", () => {
    expect(generateICS([partido({ status: "finished" })])).toContain("SUMMARY:Boca vs River");
  });

  it("sin updated_at no inventa un SEQUENCE", () => {
    expect(generateICS([partido({ updatedAt: null })])).not.toContain("SEQUENCE");
  });

  it("incluye LAST-MODIFIED cuando conoce updated_at", () => {
    expect(generateICS([partido()])).toContain("LAST-MODIFIED:20261020T100000Z");
  });
});
