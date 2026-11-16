// Textos de la página pública de liga (docs/34 L1 y L2)
import { describe, expect, it } from "vitest";
import { descripcionLiga, encabezadoLiga, respuestaLiga, tituloLiga } from "../../../src/lib/seo-liga";
import { fraseResultado } from "../../../src/lib/seo-partido";

const river = { id: "river", name: "River Plate", logo: null };
const boca = { id: "boca", name: "Boca Juniors", logo: null };
const lpf = { id: "lpf", name: "Liga Profesional Argentina", country: "Argentina" };
const champions = { id: "ucl", name: "UEFA Champions League", country: "Europa" };

// Sábado 21/11/2026 a las 15:00 de Argentina (18:00 UTC)
const SABADO = new Date("2026-11-21T18:00:00Z");
// "Hoy" de los tests: cuatro días después, en el mismo año
const AHORA = new Date("2026-11-25T12:00:00Z");

function partido(over: Partial<{ id: string; dateTime: Date; status: string | null; round: string | null; homeScore: number | null; awayScore: number | null }> = {}) {
  return {
    match: { id: "p1", dateTime: SABADO, venue: "Monumental", status: "scheduled", round: null, homeScore: null, awayScore: null, ...over },
    homeTeam: river,
    awayTeam: boca,
    league: lpf,
  };
}
const jugado = (homeScore: number | null, awayScore: number | null) => partido({ status: "finished", homeScore, awayScore });

describe("título y encabezado de liga (L1)", () => {
  it("usan las dos formas de búsqueda sin repetirlas", () => {
    expect(tituloLiga("La Liga")).toBe("Fixture y partidos de La Liga - FISTURE");
    expect(encabezadoLiga("La Liga")).toBe("Fixture y partidos de La Liga");
  });
});

describe("descripcionLiga", () => {
  it("nombra el país solo si no está en el nombre de la liga", () => {
    expect(descripcionLiga(lpf, 30)).toBe(
      "Fixture y partidos de Liga Profesional Argentina: los 30 equipos y sus próximos partidos con día y hora. Sincronizalos con Google Calendar u Outlook."
    );
    expect(descripcionLiga(champions, 36)).toMatch(/^Fixture y partidos de UEFA Champions League \(Europa\): los 36 equipos /);
  });

  it("sin equipos no menciona la cantidad", () => {
    expect(descripcionLiga(champions, 0)).toBe(
      "Fixture y partidos de UEFA Champions League (Europa): los próximos partidos con día y hora. Sincronizalos con Google Calendar u Outlook."
    );
  });
});

describe("respuestaLiga (L2)", () => {
  it("con próximo partido dice quiénes juegan, el día y la hora de Argentina", () => {
    expect(respuestaLiga(lpf, partido())).toBe(
      "El próximo partido de Liga Profesional Argentina es River Plate vs Boca Juniors, el sábado 21 de noviembre a las 15:00 (hora de Argentina)."
    );
  });

  it("suma la ronda entre paréntesis si existe y la ignora si está vacía", () => {
    expect(respuestaLiga(lpf, partido({ round: " Fecha 16 " }))).toContain("es River Plate vs Boca Juniors (Fecha 16), el sábado");
    expect(respuestaLiga(lpf, partido({ round: "  " }))).toContain("es River Plate vs Boca Juniors, el sábado");
  });

  it("con próximo partido no menciona el último resultado", () => {
    expect(respuestaLiga(lpf, partido(), jugado(2, 1))).not.toContain("último");
  });

  it("sin próximos nombra el último resultado: victoria local, victoria visitante y empate", () => {
    const sin = "Liga Profesional Argentina no tiene partidos programados en los próximos 30 días.";
    expect(respuestaLiga(lpf, undefined, jugado(2, 1), AHORA)).toBe(`${sin} En el último partido, River Plate le ganó 2 a 1 a Boca Juniors el sábado 21 de noviembre.`);
    expect(respuestaLiga(lpf, undefined, jugado(0, 3), AHORA)).toBe(`${sin} En el último partido, Boca Juniors le ganó 3 a 0 a River Plate el sábado 21 de noviembre.`);
    expect(respuestaLiga(lpf, undefined, jugado(1, 1), AHORA)).toBe(`${sin} En el último partido, River Plate y Boca Juniors empataron 1 a 1 el sábado 21 de noviembre.`);
  });

  it("un último partido de otro año lleva el año, para que no se lea como reciente", () => {
    const enero = new Date("2027-01-10T12:00:00Z");
    expect(respuestaLiga(lpf, undefined, jugado(2, 1), enero)).toMatch(/a Boca Juniors el sábado 21 de noviembre de 2026\.$/);
    expect(respuestaLiga(lpf, undefined, jugado(null, null), enero)).toMatch(/Boca Juniors, el sábado 21 de noviembre de 2026\.$/);
  });

  it("el año se decide con el día de Argentina, no con el de UTC", () => {
    // 31/12/2026 a las 22:00 de Argentina ya es 1/1/2027 en UTC
    const finDeAnio = partido({ status: "finished", homeScore: 1, awayScore: 0, dateTime: new Date("2027-01-01T01:00:00Z") });
    expect(respuestaLiga(lpf, undefined, finDeAnio, new Date("2027-01-01T02:00:00Z"))).toMatch(/el jueves 31 de diciembre\.$/);
    expect(respuestaLiga(lpf, undefined, finDeAnio, new Date("2027-01-01T04:00:00Z"))).toMatch(/el jueves 31 de diciembre de 2026\.$/);
  });

  it("sin marcador cargado no inventa el resultado", () => {
    expect(respuestaLiga(lpf, undefined, jugado(null, null), AHORA)).toBe(
      "Liga Profesional Argentina no tiene partidos programados en los próximos 30 días. El último partido fue River Plate vs Boca Juniors, el sábado 21 de noviembre."
    );
  });

  it("sin ningún partido lo dice sin dejar huecos", () => {
    expect(respuestaLiga(champions)).toBe(
      "UEFA Champions League no tiene partidos programados en los próximos 30 días. Aparecen acá apenas se confirme el fixture."
    );
  });
});

describe("fraseResultado", () => {
  it("solo existe para un terminado con los dos goles", () => {
    expect(fraseResultado(jugado(2, 1))).toBe("River Plate le ganó 2 a 1 a Boca Juniors");
    expect(fraseResultado(jugado(null, 1))).toBeNull();
    expect(fraseResultado(partido({ status: "live", homeScore: 1, awayScore: 0 }))).toBeNull();
  });
});
