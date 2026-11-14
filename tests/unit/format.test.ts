import { describe, expect, it } from "vitest";
import { diaISO, esDiaISO, rangoDelDia, sumarDias, hora, horaFin, fechaHora, fechaCorta, fechaLarga, fechaMovil, diaSemanaCorto, primerNombre, providerLabel, horaPorPais, horaConDia, listaConY } from "../../src/lib/format";

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

// docs/33 D4: hora por país con zonas IANA (Chile, Paraguay, México y España tienen o tuvieron horario de verano)
describe("horaPorPais", () => {
  const resumen = (fecha: Date) => horaPorPais(fecha).map((g) => `${horaConDia(g)} ${g.paises.join(", ")}`);

  it("15:00 de Argentina en julio (invierno austral, verano en España)", () => {
    expect(resumen(new Date("2026-07-12T18:00:00Z"))).toEqual([
      "15:00 Argentina, Uruguay, Brasil, Paraguay",
      "14:00 Chile, Bolivia, Venezuela",
      "13:00 Colombia, Perú, Ecuador",
      "12:00 México (CDMX)",
      "20:00 España (península)",
    ]);
  });

  it("15:00 de Argentina en enero (verano en Chile, invierno en España)", () => {
    expect(resumen(new Date("2027-01-10T18:00:00Z"))).toEqual([
      "15:00 Argentina, Uruguay, Brasil, Chile, Paraguay",
      "14:00 Bolivia, Venezuela",
      "13:00 Colombia, Perú, Ecuador",
      "12:00 México (CDMX)",
      "19:00 España (península)",
    ]);
  });

  it("21:00 de Argentina cae al día siguiente en España, en enero y en julio", () => {
    const enero = horaPorPais(new Date("2027-01-11T00:00:00Z"));
    expect(enero.at(-1)).toEqual({ hora: "01:00", paises: ["España (península)"], desfaseDias: 1, diaSemana: "lunes" });
    expect(enero[0]).toMatchObject({ hora: "21:00", desfaseDias: 0 });
    expect(resumen(new Date("2026-07-13T00:00:00Z")).at(-1)).toBe("02:00 del lunes España (península)");
  });

  it("pasada la medianoche argentina, en el norte todavía es el día anterior", () => {
    expect(resumen(new Date("2026-07-13T03:30:00Z"))).toEqual([
      "00:30 Argentina, Uruguay, Brasil, Paraguay",
      "23:30 del domingo Chile, Bolivia, Venezuela",
      "22:30 del domingo Colombia, Perú, Ecuador",
      "21:30 del domingo México (CDMX)",
      "05:30 España (península)",
    ]);
  });

  it("agrupa por hora y día: misma hora en distinto día no se junta", () => {
    const paises = [
      { pais: "A", zona: "America/Argentina/Buenos_Aires" },
      { pais: "B", zona: "Pacific/Kiritimati" }, // UTC+14: 15:00 de Argentina es las 08:00 del día siguiente
      { pais: "C", zona: "America/Argentina/Buenos_Aires" },
    ];
    const grupos = horaPorPais(new Date("2027-01-10T18:00:00Z"), paises);
    expect(grupos.map((g) => g.paises)).toEqual([["A", "C"], ["B"]]);
    expect(grupos[1]).toMatchObject({ desfaseDias: 1, diaSemana: "lunes" });
  });

  it("enumera países con coma e y", () => {
    expect(listaConY(["Argentina"])).toBe("Argentina");
    expect(listaConY(["Argentina", "Uruguay"])).toBe("Argentina y Uruguay");
    expect(listaConY(["Argentina", "Uruguay", "Brasil"])).toBe("Argentina, Uruguay y Brasil");
    expect(listaConY([])).toBe("");
  });
});
