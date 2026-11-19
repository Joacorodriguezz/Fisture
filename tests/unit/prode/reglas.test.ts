import { describe, expect, it } from "vitest";
import {
  PUNTOS_ACIERTO,
  PUNTOS_EXACTO,
  calcularPuntos,
  compararParticipantes,
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

  it("devuelve 0 cuando todo coincide, incluido el nombre", () => {
    expect(compararParticipantes(p("Ana", 3, 1, 1), p("ana", 3, 1, 1))).toBe(0);
  });
});
