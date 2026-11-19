// Horario de los partidos del prode de playoffs: lo que se muestra y lo que cierra el pronóstico
// salen del mismo instante (matches.date_time).
import { describe, expect, it } from "vitest";
import {
  cierraPronostico,
  esFase,
  etiquetaFase,
  horarioArgentino,
  parsearHorarioArgentino,
} from "../../src/lib/prode/horario";

describe("parsearHorarioArgentino", () => {
  it("interpreta la fecha y hora cargadas como hora argentina (UTC-3)", () => {
    expect(parsearHorarioArgentino("2026-11-22T21:00")?.toISOString()).toBe("2026-11-23T00:00:00.000Z");
    expect(parsearHorarioArgentino("2026-11-22T09:30")?.toISOString()).toBe("2026-11-22T12:30:00.000Z");
  });

  it("rechaza formatos ambiguos o fechas imposibles", () => {
    for (const valor of ["", "2026-11-22", "2026-11-22T21:00Z", "2026-11-22T21:00:00-03:00", "22/11/2026 21:00", "2026-02-30T10:00", "2026-11-22T25:00", 123, null]) {
      expect(parsearHorarioArgentino(valor as any)).toBeNull();
    }
  });
});

describe("horarioArgentino", () => {
  it("muestra fecha y hora en hora argentina aunque el servidor corra en UTC", () => {
    const instante = new Date("2026-11-23T00:00:00.000Z");
    expect(horarioArgentino(instante)).toEqual({ fecha: "Dom 22/11", hora: "21:00", iso: "2026-11-22T21:00-03:00" });
  });

  it("ida y vuelta: lo cargado es lo que se muestra", () => {
    const instante = parsearHorarioArgentino("2026-12-06T17:45")!;
    expect(horarioArgentino(instante).iso).toBe("2026-12-06T17:45-03:00");
  });
});

describe("cierraPronostico", () => {
  const partido = { dateTime: parsearHorarioArgentino("2026-11-22T21:00")! };

  it("está abierto antes del horario mostrado y cerrado desde ese instante", () => {
    expect(cierraPronostico(partido, new Date("2026-11-22T23:59:59.999Z"))).toBe(false);
    expect(cierraPronostico(partido, new Date("2026-11-23T00:00:00.000Z"))).toBe(true);
    expect(cierraPronostico(partido, new Date("2026-11-23T02:00:00.000Z"))).toBe(true);
  });

  it("un horario reprogramado mueve el cierre con él", () => {
    const reprogramado = { dateTime: parsearHorarioArgentino("2026-11-23T19:00")! };
    expect(cierraPronostico(reprogramado, new Date("2026-11-23T00:00:00.000Z"))).toBe(false);
  });

  it("acepta el instante en epoch (segundos de D1 ya convertidos a Date) o en ms", () => {
    expect(cierraPronostico({ dateTime: partido.dateTime.getTime() }, new Date("2026-11-23T00:00:00.000Z"))).toBe(true);
  });
});

describe("fases", () => {
  it("solo admite las fases de playoffs y tiene etiqueta para cada una", () => {
    for (const f of ["octavos", "cuartos", "semifinal", "final"]) {
      expect(esFase(f)).toBe(true);
      expect(etiquetaFase(f as any)).toMatch(/\S/);
    }
    for (const f of ["Final", "grupos", "", 1, null]) expect(esFase(f)).toBe(false);
    expect(etiquetaFase("cuartos")).toBe("Cuartos de final");
  });
});
