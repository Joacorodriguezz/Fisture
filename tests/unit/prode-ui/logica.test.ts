import { describe, expect, it } from "vitest";
import { enlaceInvitacion, formatearCierre, mensajeDeError, normalizarRanking, parsearGol } from "../../../src/components/prode/logica";

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
