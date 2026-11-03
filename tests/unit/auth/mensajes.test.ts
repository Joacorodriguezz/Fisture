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
  it("email_en_uso nombra el proveedor de la cuenta existente y no la une sin confirmación", () => {
    const m = mensajeErrorAuth("email_en_uso", "google")!;
    expect(m).toContain("Google");
    expect(m).toContain("Configuración");
  });

  it("email_en_uso con un proveedor desconocido no inventa un nombre ni refleja el parámetro", () => {
    const m = mensajeErrorAuth("email_en_uso", "<script>alert(1)</script>")!;
    expect(m).not.toContain("<script>");
    expect(m).toContain("otro proveedor");
  });

  it.each(["identidad_en_uso", "email_ausente", "vinculo_sesion", "proveedor_en_uso"])("%s tiene un mensaje", (codigo) => {
    expect(mensajeErrorAuth(codigo, "microsoft")).toEqual(expect.any(String));
  });

  it("un código desconocido da null (la página usa su mensaje genérico)", () => {
    expect(mensajeErrorAuth("inventado", null)).toBeNull();
  });
});
