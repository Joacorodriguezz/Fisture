import { describe, expect, it } from "vitest";
import { NOMBRE_MAX, NOMBRE_MIN, validarNombreVisible } from "../../../src/lib/prode/nombre-visible";

describe("validarNombreVisible", () => {
  it("acepta un nombre válido y lo devuelve normalizado", () => {
    expect(validarNombreVisible("  El   Pibe  ")).toEqual({ ok: true, nombre: "El Pibe" });
  });

  it("normaliza a NFC (tildes compuestas y descompuestas dan lo mismo)", () => {
    const descompuesto = "José Más";
    const r = validarNombreVisible(descompuesto);
    expect(r).toEqual({ ok: true, nombre: "José Más" });
  });

  it("acepta números, guiones, puntos y guion bajo", () => {
    expect(validarNombreVisible("Tano_10 Jr.")).toEqual({ ok: true, nombre: "Tano_10 Jr." });
  });

  it("los límites son 3 y 24 caracteres", () => {
    expect(NOMBRE_MIN).toBe(3);
    expect(NOMBRE_MAX).toBe(24);
    expect(validarNombreVisible("abc").ok).toBe(true);
    expect(validarNombreVisible("a".repeat(24)).ok).toBe(true);
  });

  it("rechaza nombres cortos tras el trim", () => {
    expect(validarNombreVisible("  ab  ")).toEqual({ ok: false, error: "corto" });
    expect(validarNombreVisible("")).toEqual({ ok: false, error: "corto" });
  });

  it("rechaza nombres largos", () => {
    expect(validarNombreVisible("a".repeat(25))).toEqual({ ok: false, error: "largo" });
  });

  it("cuenta caracteres, no unidades UTF-16", () => {
    expect(validarNombreVisible("⚽".repeat(24)).ok).toBe(true);
  });

  it("rechaza caracteres de control y de formato invisibles", () => {
    expect(validarNombreVisible("Hola\u0000mundo")).toEqual({ ok: false, error: "caracteres" });
    expect(validarNombreVisible("Hola\nmundo")).toEqual({ ok: false, error: "caracteres" });
    expect(validarNombreVisible("Hola​mundo")).toEqual({ ok: false, error: "caracteres" });
    expect(validarNombreVisible("Hola‮mundo")).toEqual({ ok: false, error: "caracteres" });
  });

  it("rechaza emails", () => {
    expect(validarNombreVisible("yo@ejemplo.com")).toEqual({ ok: false, error: "contacto" });
    expect(validarNombreVisible("juan @ gmail")).toEqual({ ok: false, error: "contacto" });
  });

  it("rechaza URLs y dominios", () => {
    for (const n of ["https://x.co", "www.fisture", "visitá miweb.com", "pibe.ar"]) {
      expect(validarNombreVisible(n)).toEqual({ ok: false, error: "contacto" });
    }
  });

  it("rechaza lo que no es string", () => {
    expect(validarNombreVisible(undefined)).toEqual({ ok: false, error: "tipo" });
    expect(validarNombreVisible(42)).toEqual({ ok: false, error: "tipo" });
  });
});
