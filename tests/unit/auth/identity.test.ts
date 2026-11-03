// Política de identidades (docs/18, §3.3, D2 y D3): funciones puras, sin D1.
import { describe, expect, it } from "vitest";
import { decidirVinculo, emailVerificado, normalizarEmail, oidCoincide } from "../../../src/lib/auth/identity";

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
    ["ambos lados verificados con el auto-vínculo prendido: vincular", { identidadExistente: false, identidadVerificada: true, cuenta: { emailVerified: true }, autoVincular: true }, "vincular"],
    ["ambos lados verificados pero el auto-vínculo apagado (default): conflicto", { identidadExistente: false, identidadVerificada: true, cuenta: { emailVerified: true } }, "conflicto"],
    ["cuenta existente sin verificar: conflicto", { identidadExistente: false, identidadVerificada: true, cuenta: { emailVerified: false } }, "conflicto"],
    ["identidad nueva sin verificar: conflicto", { identidadExistente: false, identidadVerificada: false, cuenta: { emailVerified: true } }, "conflicto"],
    ["ninguno verificado: conflicto", { identidadExistente: false, identidadVerificada: false, cuenta: { emailVerified: false } }, "conflicto"],
  ] as const)("%s", (_nombre, entrada, esperado) => {
    expect(decidirVinculo(entrada)).toBe(esperado);
  });
});

// Cuentas personales (MSA): Graph /me.id es el CID de 16 hex y el oid del ID token v2 es 00000000-0000-0000-<CID partido>
describe("oidCoincide", () => {
  it.each([
    ["MSA: oid con prefijo cero y CID partido", "00000000-0000-0000-a1b2-c3d4e5f60718", "a1b2c3d4e5f60718", true],
    ["MSA: mayúsculas en cualquiera de los dos", "00000000-0000-0000-A1B2-C3D4-E5F60718".replace("C3D4-E5F6", "C3D4E5F6"), "a1b2c3d4e5f60718", true],
    ["trabajo: GUID idéntico", "11111111-2222-3333-4444-555555555555", "11111111-2222-3333-4444-555555555555", true],
    ["trabajo: mayúsculas", "AAAAAAAA-2222-3333-4444-555555555555", "aaaaaaaa-2222-3333-4444-555555555555", true],
    ["trabajo: Graph sin guiones", "11111111-2222-3333-4444-555555555555", "11111111222233334444555555555555", true],
    ["MSA: otro CID", "00000000-0000-0000-a1b2-c3d4e5f60718", "ffffffffffffffff", false],
    ["trabajo: otro oid", "11111111-2222-3333-4444-555555555555", "11111111-2222-3333-4444-555555555556", false],
    ["un GUID de trabajo no se confunde con un CID por sufijo", "11111111-2222-3333-4444-a1b2c3d4e5f60718".slice(0, 36), "a1b2c3d4e5f60718", false],
  ])("%s", (_n, oid, graphId, esperado) => {
    expect(oidCoincide(oid, graphId)).toBe(esperado);
  });
});
