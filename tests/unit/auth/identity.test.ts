// Política de identidades (docs/18, §3.3, D2 y D3): funciones puras, sin D1.
import { describe, expect, it } from "vitest";
import { decidirVinculo, emailVerificado, normalizarEmail } from "../../../src/lib/auth/identity";

describe("normalizarEmail", () => {
  it.each([
    ["ana@example.com", "ana@example.com"],
    ["  Ana@Example.COM ", "ana@example.com"],
    ["a.b+x@gmail.com", "a.b+x@gmail.com"], // no se asume que los puntos ni los alias sean la misma persona
    ["", ""],
    ["   ", ""],
    [undefined, ""],
    [null, ""],
    [42, ""],
  ])("%j -> %j", (entrada, esperado) => {
    expect(normalizarEmail(entrada)).toBe(esperado);
  });
});

describe("emailVerificado (D2)", () => {
  it.each([
    ["google", { email_verified: true }, true],
    ["google", { email_verified: false }, false],
    ["google", {}, false],
    ["google", { email_verified: "true" }, false], // solo el booleano de Google cuenta
    ["microsoft", {}, false],
    ["microsoft", { email_verified: true }, false], // Microsoft no emite este claim
    ["microsoft", { xms_edov: true }, false], // fail closed hasta confirmar el spike
  ] as const)("%s %j -> %s", (provider, claims, esperado) => {
    expect(emailVerificado(provider, claims)).toBe(esperado);
  });

  it("Microsoft con xms_edov=true solo cuenta si el spike lo habilita explícitamente", () => {
    expect(emailVerificado("microsoft", { xms_edov: true }, { confiarXmsEdov: true })).toBe(true);
    expect(emailVerificado("microsoft", { xms_edov: false }, { confiarXmsEdov: true })).toBe(false);
    expect(emailVerificado("microsoft", {}, { confiarXmsEdov: true })).toBe(false);
  });
});

describe("decidirVinculo (D3)", () => {
  it.each([
    ["la identidad ya existe: login", { identidadExistente: true, identidadVerificada: false, cuenta: null }, "login"],
    ["sin cuenta con ese email: crear", { identidadExistente: false, identidadVerificada: false, cuenta: null }, "crear"],
    ["ambos lados verificados: vincular", { identidadExistente: false, identidadVerificada: true, cuenta: { emailVerified: true } }, "vincular"],
    ["cuenta existente sin verificar: conflicto", { identidadExistente: false, identidadVerificada: true, cuenta: { emailVerified: false } }, "conflicto"],
    ["identidad nueva sin verificar: conflicto", { identidadExistente: false, identidadVerificada: false, cuenta: { emailVerified: true } }, "conflicto"],
    ["ninguno verificado: conflicto", { identidadExistente: false, identidadVerificada: false, cuenta: { emailVerified: false } }, "conflicto"],
  ] as const)("%s", (_nombre, entrada, esperado) => {
    expect(decidirVinculo(entrada)).toBe(esperado);
  });
});
