// Textos y datos estructurados de la página pública de equipo (docs/33 D1, D2, D3, D6)
import { describe, expect, it } from "vitest";
import {
  descripcionEquipo,
  encabezadoEquipo,
  jsonLdPartidosDeEquipo,
  respuestaProximoPartido,
  resultadoDelEquipo,
  tituloEquipo,
  TOPE_EVENTOS_EQUIPO,
} from "../../../src/lib/seo-equipo";

const BASE = "https://fisture.test";
const barracas = { id: "barracas", name: "Barracas Central", logo: null };
const defensa = { id: "defensa", name: "Defensa y Justicia", logo: null };
const lpf = { id: "lpf", name: "Liga Profesional Argentina" };

// Sábado 21/11/2026 a las 15:00 de Argentina (18:00 UTC)
const SABADO = new Date("2026-11-21T18:00:00Z");

function partido(over: Partial<{ id: string; dateTime: Date; venue: string | null; status: string | null; homeScore: number | null; awayScore: number | null }> = {}, local = defensa, visitante = barracas) {
  return {
    match: { id: "p1", dateTime: SABADO, venue: "Norberto Tomaghello", status: "scheduled", round: null, homeScore: null, awayScore: null, ...over },
    homeTeam: local,
    awayTeam: visitante,
    league: lpf,
  };
}

describe("título y encabezado de equipo (D1)", () => {
  it("usan las dos formas de búsqueda sin repetirlas", () => {
    expect(tituloEquipo("Barracas Central")).toBe("Partidos y fixture de Barracas Central - FISTURE");
    expect(encabezadoEquipo("Barracas Central")).toBe("Fixture y partidos de Barracas Central");
  });
});

describe("descripcionEquipo", () => {
  it("empieza por el equipo y la liga, y sigue con el próximo partido", () => {
    expect(descripcionEquipo(barracas, lpf, partido())).toBe(
      "Partidos y fixture de Barracas Central (Liga Profesional Argentina): próximo partido Defensa y Justicia vs Barracas Central, Sáb 21/11 a las 15:00. Sincronizalo con tu calendario."
    );
  });

  it("sin liga ni próximo partido no deja huecos", () => {
    expect(descripcionEquipo(barracas, null, undefined)).toBe(
      "Partidos y fixture de Barracas Central: próximos partidos con día y hora, y últimos resultados. Sincronizalo con tu calendario."
    );
  });
});

describe("respuestaProximoPartido (D2)", () => {
  it("de visitante: día, hora argentina, rival, competencia y estadio", () => {
    expect(respuestaProximoPartido(barracas, partido())).toBe(
      "Barracas Central juega su próximo partido el sábado 21 de noviembre a las 15:00 (hora de Argentina) contra Defensa y Justicia, de visitante, por Liga Profesional Argentina, en el estadio Norberto Tomaghello."
    );
  });

  it("de local", () => {
    expect(respuestaProximoPartido(defensa, partido())).toContain("contra Barracas Central, de local, por");
  });

  it("sin sede conocida omite el estadio", () => {
    expect(respuestaProximoPartido(barracas, partido({ venue: null }))).toBe(
      "Barracas Central juega su próximo partido el sábado 21 de noviembre a las 15:00 (hora de Argentina) contra Defensa y Justicia, de visitante, por Liga Profesional Argentina."
    );
    expect(respuestaProximoPartido(barracas, partido({ venue: "  " }))).not.toContain("estadio");
  });

  it("una sede que ya dice estadio no lo repite", () => {
    expect(respuestaProximoPartido(barracas, partido({ venue: "Estadio Monumental" }))).toMatch(/, en el Estadio Monumental\.$/);
    expect(respuestaProximoPartido(barracas, partido({ venue: "Emirates Stadium" }))).toMatch(/, en el Emirates Stadium\.$/);
  });

  it("un partido a las 21:00 de Argentina cae en ese día argentino aunque en UTC sea el siguiente", () => {
    const noche = partido({ dateTime: new Date("2026-11-22T00:00:00Z") });
    expect(respuestaProximoPartido(barracas, noche)).toContain("el sábado 21 de noviembre a las 21:00");
  });

  it("sin próximo partido ni resultados lo dice", () => {
    expect(respuestaProximoPartido(barracas, undefined, undefined)).toBe(
      "Barracas Central todavía no tiene un próximo partido confirmado. Aparece acá apenas se confirme el fixture."
    );
  });

  it("sin próximo partido menciona el último resultado, con marcador desde el lado del equipo", () => {
    const ganado = partido({ status: "finished", homeScore: 0, awayScore: 2 });
    expect(respuestaProximoPartido(barracas, undefined, ganado)).toBe(
      "Barracas Central todavía no tiene un próximo partido confirmado. Su último partido fue el sábado 21 de noviembre contra Defensa y Justicia, de visitante, por Liga Profesional Argentina, y ganó 2 a 0."
    );
    expect(respuestaProximoPartido(defensa, undefined, ganado)).toMatch(/de local, por Liga Profesional Argentina, y perdió 0 a 2\.$/);
    expect(respuestaProximoPartido(defensa, undefined, partido({ status: "finished", homeScore: 1, awayScore: 1 }))).toMatch(/y empató 1 a 1\.$/);
  });

  it("sin marcador cargado no inventa el resultado", () => {
    const sinMarcador = partido({ status: "finished", homeScore: 1, awayScore: null });
    expect(respuestaProximoPartido(barracas, undefined, sinMarcador)).toBe(
      "Barracas Central todavía no tiene un próximo partido confirmado. Su último partido fue el sábado 21 de noviembre contra Defensa y Justicia, de visitante, por Liga Profesional Argentina."
    );
  });
});

describe("resultadoDelEquipo (D3)", () => {
  it("da goles propios, ajenos y el resultado desde el lado del equipo", () => {
    const m = partido({ status: "finished", homeScore: 3, awayScore: 1 }).match;
    expect(resultadoDelEquipo(m, true)).toEqual({ propios: 3, ajenos: 1, resultado: "ganó" });
    expect(resultadoDelEquipo(m, false)).toEqual({ propios: 1, ajenos: 3, resultado: "perdió" });
  });

  it("con 0 a 0 empata; con un marcador nulo devuelve null", () => {
    expect(resultadoDelEquipo({ homeScore: 0, awayScore: 0 }, true)?.resultado).toBe("empató");
    expect(resultadoDelEquipo({ homeScore: null, awayScore: 0 }, true)).toBeNull();
    expect(resultadoDelEquipo({ homeScore: 2, awayScore: null }, false)).toBeNull();
  });
});

describe("jsonLdPartidosDeEquipo (D6)", () => {
  it("publica solo los programados como SportsEvent", () => {
    const lista = [
      partido({ id: "a" }),
      partido({ id: "b", status: "postponed" }),
      partido({ id: "c", status: "cancelled" }),
      partido({ id: "d" }),
    ];
    const eventos = jsonLdPartidosDeEquipo(BASE, lista);
    expect(eventos.map((e) => e.url)).toEqual([`${BASE}/partidos/a`, `${BASE}/partidos/d`]);
    expect(eventos[0]).toMatchObject({ "@type": "SportsEvent", name: "Defensa y Justicia vs Barracas Central" });
  });

  it("corta en 10", () => {
    const lista = Array.from({ length: 15 }, (_, i) => partido({ id: `p${i}` }));
    expect(TOPE_EVENTOS_EQUIPO).toBe(10);
    expect(jsonLdPartidosDeEquipo(BASE, lista)).toHaveLength(10);
    expect(jsonLdPartidosDeEquipo(BASE, [])).toEqual([]);
  });
});
