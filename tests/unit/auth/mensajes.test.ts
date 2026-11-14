// Mensajes de error de autenticación (docs/18 §4.1).
import { describe, expect, it } from "vitest";
import { mensajeErrorAuth, nombreProveedor } from "../../../src/lib/auth/mensajes";

describe("nombreProveedor", () => {
  it.each([
    ["google", "Google"],
    ["microsoft", "Microsoft"],
    ["apple", null],
    [null, null],
  ])("%s -> %s", (p, esperado) => {
    expect(nombreProveedor(p)).toBe(esperado);
  });
});

describe("mensajeErrorAuth", () => {
  it("email_en_uso es genérico: no nombra ningún proveedor aunque llegue en la URL", () => {
    for (const proveedor of ["google", "microsoft", "<script>alert(1)</script>", null]) {
      const m = mensajeErrorAuth("email_en_uso", proveedor)!;
      expect(m).not.toMatch(/Google|Microsoft|script/);
      expect(m).toContain("desde Cuenta");
    }
  });

  it.each(["identidad_en_uso", "email_ausente", "vinculo_sesion", "proveedor_en_uso"])("%s tiene un mensaje", (codigo) => {
    expect(mensajeErrorAuth(codigo, "microsoft")).toEqual(expect.any(String));
  });

  it("un código desconocido da null (la página usa su mensaje genérico)", () => {
    expect(mensajeErrorAuth("inventado", null)).toBeNull();
  });
});
