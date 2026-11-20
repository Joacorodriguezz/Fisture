import { describe, expect, it } from "vitest";
import { enlaceInvitacion, formatearCierre, filaPropiaAparte, mensajeDeError, normalizarRanking, normalizarRespuestaRanking, parsearGol } from "../../../src/components/prode/logica";

describe("mensajeDeError", () => {
  it("muestra 'Cerró el pronóstico' ante pronostico_cerrado", () => {
    expect(mensajeDeError(409, "pronostico_cerrado")).toBe("Cerró el pronóstico");
  });
  it("traduce sesión vencida y límite de tasa", () => {
    expect(mensajeDeError(401)).toMatch(/sesión/);
    expect(mensajeDeError(429)).toMatch(/Esperá/);
  });
  it("no revela si un código de invitación existe", () => {
    expect(mensajeDeError(404, "Invitación inválida", "unirse")).toBe(mensajeDeError(400, "otra cosa", "unirse"));
  });
  it("no muestra códigos técnicos pero sí textos en español del API", () => {
    expect(mensajeDeError(500, "boom")).toMatch(/Probá de nuevo/);
    expect(mensajeDeError(400, "El nombre debe tener entre 3 y 40", "grupo")).toBe("El nombre debe tener entre 3 y 40");
  });
});

describe("formatearCierre", () => {
  it("usa hora argentina", () => {
    expect(formatearCierre("2026-11-22T21:00:00.000-03:00")).toMatch(/22\/11 21:00 hs$/);
    expect(formatearCierre("2026-11-23T00:00:00.000Z")).toMatch(/22\/11 21:00 hs$/);
  });
  it("devuelve vacío con una fecha inválida", () => {
    expect(formatearCierre("nada")).toBe("");
  });
});

describe("parsearGol", () => {
  it("acepta enteros de 0 a 20", () => {
    expect(parsearGol(" 3 ")).toBe(3);
    expect(parsearGol("20")).toBe(20);
  });
  it("rechaza vacío, negativos, decimales y fuera de rango", () => {
    for (const t of ["", "-1", "1.5", "21", "abc", "100"]) expect(parsearGol(t)).toBeNull();
  });
});

describe("enlaceInvitacion", () => {
  it("arma /prode/unirse/<codigo> sin doble barra", () => {
    expect(enlaceInvitacion("https://fisture.pages.dev/", "abc_-")).toBe("https://fisture.pages.dev/prode/unirse/abc_-");
  });
});

describe("normalizarRanking", () => {
  it("descarta filas mal formadas y tolera cuerpos inválidos", () => {
    expect(normalizarRanking(null)).toEqual([]);
    expect(normalizarRanking({ filas: [{ posicion: 1, nombre: "Ana", puntos: 5, esVos: true }, { nombre: "x" }, 3] })).toEqual([
      { posicion: 1, nombre: "Ana", puntos: 5, esVos: true },
    ]);
  });
});

describe("normalizarRespuestaRanking", () => {
  const ana = { posicion: 1, nombre: "Ana", puntos: 5, esVos: false };
  const yo = { posicion: 130, nombre: "Luis", puntos: 0, exactos: 0, esVos: true };

  it("lee filas, total y yo", () => {
    expect(normalizarRespuestaRanking({ filas: [ana], total: 130, yo })).toEqual({ filas: [ana], total: 130, yo });
  });
  it("tolera cuerpos inválidos, yo mal formado y total ausente", () => {
    expect(normalizarRespuestaRanking(null)).toEqual({ filas: [], total: 0, yo: null });
    expect(normalizarRespuestaRanking({ filas: [ana], yo: { nombre: "x" } })).toEqual({ filas: [ana], total: 1, yo: null });
    expect(normalizarRespuestaRanking({ filas: [ana], total: "7" }).total).toBe(1);
  });
});

describe("filaPropiaAparte", () => {
  const visible = { posicion: 1, nombre: "Ana", puntos: 5, esVos: false };
  const yo = { posicion: 130, nombre: "Luis", puntos: 0, esVos: true };

  it("devuelve yo cuando no está entre las filas visibles", () => {
    expect(filaPropiaAparte([visible], yo)).toEqual(yo);
  });
  it("no la repite si ya está visible o si no hay yo", () => {
    expect(filaPropiaAparte([visible, { ...yo, posicion: 2 }], yo)).toBeNull();
    expect(filaPropiaAparte([visible], null)).toBeNull();
  });
});
