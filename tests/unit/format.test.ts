import { describe, expect, it } from "vitest";
import { diaISO, esDiaISO, rangoDelDia, sumarDias, hora, horaFin, fechaHora, fechaCorta, fechaLarga, fechaMovil, diaSemanaCorto, primerNombre, providerLabel } from "../../src/lib/format";

describe("fechas en Buenos Aires", () => {
  it("usa el día anterior cerca de la medianoche UTC", () => {
    const date = new Date("2026-10-21T01:30:00Z");
    expect(diaISO(date)).toBe("2026-10-20");
    expect(hora(date)).toBe("22:30");
    expect(horaFin(date)).toBe("00:30");
    expect(fechaHora(date)).toBe("20/10 22:30");
    expect(fechaCorta(date)).toContain("20/10");
    expect(fechaLarga(date)).toContain("20 de octubre");
  });
  it.each(["2024-02-29", "2026-12-31"])("acepta fecha válida %s", (day) => expect(esDiaISO(day)).toBe(true));
  it.each(["2026-02-29", "2026-02-30", "2026-13-01", "2026-1-01", "", null, undefined])("rechaza fecha inválida %s", (day) => expect(esDiaISO(day)).toBe(false));
  it("calcula un rango semiabierto de 24 horas y cruza año/mes", () => {
    const { desde, hasta } = rangoDelDia("2026-12-31");
    expect(desde.toISOString()).toBe("2026-12-31T03:00:00.000Z");
    expect(hasta.toISOString()).toBe("2027-01-01T03:00:00.000Z");
    expect(sumarDias("2026-12-31", 1)).toBe("2027-01-01");
    expect(sumarDias("2024-03-01", -1)).toBe("2024-02-29");
  });
  it("la cabecera y la tira móvil respetan el día argentino y no muestran puntos", () => {
    const midnightUtc = new Date("2026-10-21T01:30:00Z");
    expect(fechaMovil(midnightUtc)).toBe("Mar 20 de octubre");
    expect(diaSemanaCorto(midnightUtc)).toBe("mar");
    expect(fechaMovil(new Date("2027-01-01T01:00:00Z"))).toBe("Jue 31 de diciembre");
  });
});

it("usa nombre o email y etiquetas conocidas del calendario", () => {
  expect(primerNombre("  Ana Pérez ", "fallback@example.test")).toBe("Ana");
  expect(primerNombre(null, "fallback@example.test")).toBe("fallback");
  expect(providerLabel("google")).toBe("Google Calendar");
  expect(providerLabel("microsoft")).toBe("Outlook");
  expect(providerLabel("other")).toBe("calendario");
});
