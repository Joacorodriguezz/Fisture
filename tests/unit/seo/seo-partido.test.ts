// Textos de la página pública de partido (docs/33 D2 y D3)
import { describe, expect, it } from "vitest";
import { descripcionPartido, marcadorPartido, respuestaPartido, textoResultado } from "../../../src/lib/seo-partido";

const river = { id: "river", name: "River Plate", logo: null };
const boca = { id: "boca", name: "Boca Juniors", logo: null };
const lpf = { id: "lpf", name: "Liga Profesional Argentina" };

// Domingo 1/11/2026 a las 15:00 de Argentina (18:00 UTC)
const DOMINGO = new Date("2026-11-01T18:00:00Z");

type Over = Partial<{ dateTime: Date; venue: string | null; status: string | null; homeScore: number | null; awayScore: number | null }>;

function partido(over: Over = {}, local = river, visitante = boca) {
  return {
    match: { id: "p1", dateTime: DOMINGO, venue: "Monumental", status: "scheduled", round: null, homeScore: null, awayScore: null, ...over },
    homeTeam: local,
    awayTeam: visitante,
    league: lpf,
  };
}

const terminado = (homeScore: number | null, awayScore: number | null, over: Over = {}) =>
  partido({ status: "finished", homeScore, awayScore, ...over });

describe("marcadorPartido (D3)", () => {
  it("solo con el partido terminado y los dos goles cargados", () => {
    expect(marcadorPartido(terminado(1, 2).match)).toEqual({ local: 1, visitante: 2 });
    expect(marcadorPartido(terminado(0, 0).match)).toEqual({ local: 0, visitante: 0 });
    expect(marcadorPartido(terminado(1, null).match)).toBeNull();
    expect(marcadorPartido(terminado(null, 2).match)).toBeNull();
    // Un marcador parcial de un partido en juego o un dato suelto de un programado no es un resultado
    expect(marcadorPartido(partido({ status: "live", homeScore: 1, awayScore: 0 }).match)).toBeNull();
    expect(marcadorPartido(partido({ homeScore: 0, awayScore: 0 }).match)).toBeNull();
  });

  it("textoResultado nombra a los dos equipos con sus goles", () => {
    expect(textoResultado(terminado(1, 2))).toBe("River Plate 1, Boca Juniors 2");
    expect(textoResultado(terminado(null, null))).toBeNull();
  });
});

describe("respuestaPartido (D2)", () => {
  it("programado: equipos, día, hora argentina, competencia y estadio", () => {
    expect(respuestaPartido(partido())).toBe(
      "River Plate y Boca Juniors juegan el domingo 1 de noviembre a las 15:00 (hora de Argentina) por Liga Profesional Argentina, en el estadio Monumental."
    );
  });

  it("sin sede omite el estadio y una sede que ya dice estadio no lo repite", () => {
    expect(respuestaPartido(partido({ venue: null }))).toBe(
      "River Plate y Boca Juniors juegan el domingo 1 de noviembre a las 15:00 (hora de Argentina) por Liga Profesional Argentina."
    );
    expect(respuestaPartido(partido({ venue: "Estadio Monumental" }))).toMatch(/, en el Estadio Monumental\.$/);
  });

  it("21:00 de Argentina usa el día argentino aunque en UTC sea el siguiente", () => {
    expect(respuestaPartido(partido({ dateTime: new Date("2026-11-02T00:00:00Z") }))).toContain("el domingo 1 de noviembre a las 21:00");
  });

  it("en juego lo dice", () => {
    expect(respuestaPartido(partido({ status: "live" }))).toBe(
      "River Plate y Boca Juniors están jugando: el partido empezó el domingo 1 de noviembre a las 15:00 (hora de Argentina), por Liga Profesional Argentina, en el estadio Monumental."
    );
  });

  it("terminado con victoria del local o del visitante: el ganador primero", () => {
    expect(respuestaPartido(terminado(2, 1))).toBe(
      "River Plate le ganó 2 a 1 a Boca Juniors el domingo 1 de noviembre, por Liga Profesional Argentina, en el estadio Monumental."
    );
    expect(respuestaPartido(terminado(1, 2, { venue: "La Bombonera" }))).toBe(
      "Boca Juniors le ganó 2 a 1 a River Plate el domingo 1 de noviembre, por Liga Profesional Argentina, en el estadio La Bombonera."
    );
  });

  it("terminado empatado", () => {
    expect(respuestaPartido(terminado(1, 1))).toBe(
      "River Plate y Boca Juniors empataron 1 a 1 el domingo 1 de noviembre, por Liga Profesional Argentina, en el estadio Monumental."
    );
    expect(respuestaPartido(terminado(0, 0, { venue: null }))).toBe(
      "River Plate y Boca Juniors empataron 0 a 0 el domingo 1 de noviembre, por Liga Profesional Argentina."
    );
  });

  it("terminado sin marcador: dice que se jugó y que el resultado no está cargado, sin inventarlo", () => {
    const texto = respuestaPartido(terminado(1, null));
    expect(texto).toBe(
      "River Plate y Boca Juniors jugaron el domingo 1 de noviembre a las 15:00 (hora de Argentina) por Liga Profesional Argentina, en el estadio Monumental. El resultado todavía no está cargado."
    );
    expect(texto).not.toMatch(/\d+ a \d+/);
  });

  it("postergado y cancelado: la fecha prevista y lo que pasó", () => {
    expect(respuestaPartido(partido({ status: "postponed" }))).toBe(
      "El partido entre River Plate y Boca Juniors por Liga Profesional Argentina, previsto para el domingo 1 de noviembre a las 15:00 (hora de Argentina), fue postergado. La nueva fecha todavía no está confirmada."
    );
    expect(respuestaPartido(partido({ status: "cancelled" }))).toBe(
      "El partido entre River Plate y Boca Juniors por Liga Profesional Argentina, previsto para el domingo 1 de noviembre a las 15:00 (hora de Argentina), fue cancelado."
    );
  });

  it("un estado desconocido se trata como programado", () => {
    expect(respuestaPartido(partido({ status: null }))).toMatch(/^River Plate y Boca Juniors juegan el /);
  });
});

describe("descripcionPartido", () => {
  it("programado: igual que antes, con la invitación a agregarlo al calendario", () => {
    expect(descripcionPartido(partido())).toBe(
      "River Plate vs Boca Juniors por Liga Profesional Argentina: domingo 1 de noviembre a las 15:00 (hora argentina) en Monumental. Agregalo a tu calendario con recordatorios."
    );
    expect(descripcionPartido(partido({ venue: null }))).not.toContain(" en ");
  });

  it("terminado con marcador: el resultado primero y cuándo se jugó, sin hablar en futuro", () => {
    const texto = descripcionPartido(terminado(1, 2, { venue: "La Bombonera" }));
    expect(texto).toBe(
      "River Plate 1-2 Boca Juniors por Liga Profesional Argentina: se jugó el domingo 1 de noviembre a las 15:00 (hora argentina) en La Bombonera. Resultado y ficha del partido."
    );
    expect(texto).not.toMatch(/Agregalo|calendario/);
  });

  it("terminado sin marcador: cuándo se jugó, sin resultado", () => {
    const texto = descripcionPartido(terminado(null, null, { venue: null }));
    expect(texto).toBe(
      "River Plate vs Boca Juniors por Liga Profesional Argentina: se jugó el domingo 1 de noviembre a las 15:00 (hora argentina). Ficha del partido y fixture de los dos equipos."
    );
    expect(texto).not.toMatch(/\d+-\d+|Agregalo/);
  });

  it("cancelado: dice que no se juega y no invita a agendarlo", () => {
    expect(descripcionPartido(partido({ status: "cancelled" }))).toBe(
      "River Plate vs Boca Juniors por Liga Profesional Argentina: fue cancelado. Estaba previsto para el domingo 1 de noviembre a las 15:00 (hora argentina) en Monumental."
    );
  });

  it("postergado: dice que la fecha puede cambiar y que el calendario se actualiza", () => {
    expect(descripcionPartido(partido({ status: "postponed" }))).toBe(
      "River Plate vs Boca Juniors por Liga Profesional Argentina: fue postergado y todavía no tiene nueva fecha. Si lo tenés en tu calendario, se actualiza solo."
    );
  });
});
