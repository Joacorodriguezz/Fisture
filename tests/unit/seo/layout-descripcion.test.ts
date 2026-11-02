import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addAttribute } from "astro/runtime/server/index.js";

// El Layout depende de D1 y del runtime de Cloudflare, así que no se puede renderizar con la
// Container API en Node. Se prueba (1) que el layout interpola `descripcion` como atributo de
// Astro y (2) que ese mecanismo (addAttribute, el helper que usa el código compilado) escapa.
const layout = readFileSync(new URL("../../../src/layouts/Layout.astro", import.meta.url), "utf8");
const MALICIOSA = 'Gol "del año" <script>alert(1)</script> & más';

describe("escape de descripcion en Layout.astro", () => {
  it("usa descripcion solo como valor de atributo, sin HTML crudo", () => {
    expect(layout).toContain('<meta name="description" content={descripcion} />');
    expect(layout).toContain('<meta property="og:description" content={descripcion} />');
    // El único set:html es el script fijo del tema (constante de lib/security-headers.ts, ver la CSP)
    expect(layout.replace("<script is:inline set:html={SCRIPT_TEMA} />", "")).not.toContain("set:html");
  });

  it("el atributo no se rompe con comillas ni con &", () => {
    const html = `<meta name="description"${String(addAttribute(MALICIOSA, "content"))} />`;
    const valor = html.match(/ content="([^]*)" \/>$/)![1];
    expect(valor).not.toContain('"');
    expect(valor).toContain("&#34;del año&#34;");
    expect(valor).toContain("&#38; más");
    expect((html.match(/"/g) ?? []).length).toBe(4);
  });
});
