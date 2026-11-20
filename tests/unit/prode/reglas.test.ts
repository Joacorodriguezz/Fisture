import { describe, expect, it } from "vitest";
import {
  PUNTOS_ACIERTO,
  PUNTOS_EXACTO,
  calcularExtraPasa,
  calcularPuntos,
  compararParticipantes,
  ladoQuePasa,
  puntosDelPartido,
  type Participante,
} from "../../../src/lib/prode/reglas";

describe("calcularPuntos", () => {
  it("da 3 puntos por el resultado exacto", () => {
    expect(calcularPuntos({ local: 2, visitante: 1 }, { local: 2, visitante: 1 })).toBe(PUNTOS_EXACTO);
    expect(PUNTOS_EXACTO).toBe(3);
  });

  it("da 1 punto por acertar el ganador sin el resultado exacto", () => {
    expect(calcularPuntos({ local: 1, visitante: 0 }, { local: 3, visitante: 1 })).toBe(PUNTOS_ACIERTO);
    expect(calcularPuntos({ local: 0, visitante: 2 }, { local: 1, visitante: 4 })).toBe(PUNTOS_ACIERTO);
    expect(PUNTOS_ACIERTO).toBe(1);
  });

  it("da 3 puntos por un empate exacto, sin sumarle el punto del acierto", () => {
    expect(calcularPuntos({ local: 1, visitante: 1 }, { local: 1, visitante: 1 })).toBe(3);
    expect(calcularPuntos({ local: 0, visitante: 0 }, { local: 0, visitante: 0 })).toBe(3);
  });

  it("da 1 punto por acertar el empate con otro marcador", () => {
    expect(calcularPuntos({ local: 0, visitante: 0 }, { local: 2, visitante: 2 })).toBe(1);
  });

  it("da 0 puntos si falla el ganador o el empate", () => {
    expect(calcularPuntos({ local: 2, visitante: 0 }, { local: 0, visitante: 1 })).toBe(0);
    expect(calcularPuntos({ local: 1, visitante: 1 }, { local: 2, visitante: 1 })).toBe(0);
    expect(calcularPuntos({ local: 2, visitante: 1 }, { local: 1, visitante: 1 })).toBe(0);
  });

  it("da 0 puntos sin pronóstico o sin resultado válido (partido cancelado o aún sin jugar)", () => {
    expect(calcularPuntos(null, { local: 1, visitante: 0 })).toBe(0);
    expect(calcularPuntos({ local: 1, visitante: 0 }, null)).toBe(0);
  });
});

describe("calcularExtraPasa", () => {
  it("da +1 si el equipo pronosticado es el que pasó", () => {
    expect(calcularExtraPasa("home", "home")).toBe(1);
    expect(calcularExtraPasa("away", "away")).toBe(1);
  });

  it("da 0 si falla, o si falta el pronóstico o el equipo que pasó", () => {
    expect(calcularExtraPasa("home", "away")).toBe(0);
    expect(calcularExtraPasa(null, "home")).toBe(0);
    expect(calcularExtraPasa("home", null)).toBe(0);
  });
});

describe("ladoQuePasa", () => {
  it("con ganador se deriva del marcador, ignorando pasa", () => {
    expect(ladoQuePasa({ local: 2, visitante: 1 }, "away")).toBe("home");
    expect(ladoQuePasa({ local: 0, visitante: 3 }, null)).toBe("away");
  });

  it("con empate vale pasa; sin pasa, ninguno", () => {
    expect(ladoQuePasa({ local: 1, visitante: 1 }, "away")).toBe("away");
    expect(ladoQuePasa({ local: 1, visitante: 1 }, null)).toBeNull();
  });
});

describe("puntosDelPartido (docs/40 R1)", () => {
  it("1-1 pasa local; termina 1-1 y pasa el local por penales: 3 + 1 = 4", () => {
    expect(puntosDelPartido({ local: 1, visitante: 1, pasa: "home" }, { local: 1, visitante: 1 }, "home")).toEqual({ marcador: 3, extra: 1, total: 4 });
  });

  it("2-1 contra 1-1 con pasa el local: 0 + 1 = 1", () => {
    expect(puntosDelPartido({ local: 2, visitante: 1 }, { local: 1, visitante: 1 }, "home")).toEqual({ marcador: 0, extra: 1, total: 1 });
  });

  it("1-0 contra 0-2 del visitante: 0 + 0 = 0", () => {
    expect(puntosDelPartido({ local: 1, visitante: 0 }, { local: 0, visitante: 2 }, "away")).toEqual({ marcador: 0, extra: 0, total: 0 });
  });

  it("el máximo es 4 y el extra se suma al marcador no exacto", () => {
    expect(puntosDelPartido({ local: 2, visitante: 0 }, { local: 2, visitante: 0 }, "home").total).toBe(4);
    expect(puntosDelPartido({ local: 1, visitante: 0 }, { local: 3, visitante: 1 }, "home")).toEqual({ marcador: 1, extra: 1, total: 2 });
  });

  it("un empate pronosticado sin pasa no suma el extra", () => {
    expect(puntosDelPartido({ local: 1, visitante: 1 }, { local: 1, visitante: 1 }, "home")).toEqual({ marcador: 3, extra: 0, total: 3 });
    expect(puntosDelPartido({ local: 1, visitante: 1, pasa: null }, { local: 0, visitante: 0 }, "away")).toEqual({ marcador: 1, extra: 0, total: 1 });
  });

  it("sin pronóstico, sin resultado o sin equipo que pasó no suma el extra", () => {
    expect(puntosDelPartido(null, { local: 1, visitante: 0 }, "home")).toEqual({ marcador: 0, extra: 0, total: 0 });
    expect(puntosDelPartido({ local: 1, visitante: 0 }, null, null)).toEqual({ marcador: 0, extra: 0, total: 0 });
    expect(puntosDelPartido({ local: 1, visitante: 0 }, { local: 1, visitante: 0 }, null)).toEqual({ marcador: 3, extra: 0, total: 3 });
  });
});

const p = (nombre: string, puntos: number, exactos: number, aciertos: number): Participante => ({ nombre, puntos, exactos, aciertos });
const ordenar = (lista: Participante[]) => [...lista].sort(compararParticipantes).map((x) => x.nombre);

describe("compararParticipantes", () => {
  it("ordena por puntos de mayor a menor", () => {
    expect(ordenar([p("Ana", 4, 1, 2), p("Beto", 9, 2, 5)])).toEqual(["Beto", "Ana"]);
  });

  it("a igualdad de puntos, gana quien tiene más resultados exactos", () => {
    expect(ordenar([p("Ana", 6, 1, 4), p("Beto", 6, 2, 2)])).toEqual(["Beto", "Ana"]);
  });

  it("a igualdad de puntos y exactos, gana quien tiene más aciertos", () => {
    expect(ordenar([p("Ana", 6, 1, 3), p("Beto", 6, 1, 4)])).toEqual(["Beto", "Ana"]);
  });

  it("con todo igualado, ordena por nombre visible sin distinguir mayúsculas ni tildes", () => {
    expect(ordenar([p("zoe", 3, 1, 1), p("Álvaro", 3, 1, 1), p("Bruno", 3, 1, 1)])).toEqual(["Álvaro", "Bruno", "zoe"]);
  });

  // Los totales de puntos.ts traen además `pasa` (aciertos de quién pasa): informativo, nunca desempata (docs/40 R5)
  it("el contador de aciertos de quién pasa no desempata: con lo demás igual, decide el nombre", () => {
    const con = (nombre: string, pasa: number) => ({ ...p(nombre, 6, 1, 3), pasa }) as Participante;
    expect(ordenar([con("Beto", 9), con("Ana", 0)])).toEqual(["Ana", "Beto"]);
    expect(compararParticipantes(con("Ana", 0), con("ana", 9))).toBe(0);
  });

  it("devuelve 0 cuando todo coincide, incluido el nombre", () => {
    expect(compararParticipantes(p("Ana", 3, 1, 1), p("ana", 3, 1, 1))).toBe(0);
  });
});
