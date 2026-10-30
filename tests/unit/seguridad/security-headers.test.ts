import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { conHeadersDeSeguridad, construirCsp, hashesDeScriptsInline, HEADERS_FIJOS } from "../../../src/lib/security-headers";

const sha256 = (texto: string) => `sha256-${createHash("sha256").update(texto, "utf8").digest("base64")}`;

describe("hashesDeScriptsInline", () => {
  it("hashea el contenido exacto de cada script inline (con acentos y saltos de línea)", async () => {
    const tema = '\n  try { document.documentElement.dataset.theme = "nocturna"; } catch (e) {}\n';
    const isla = "customElements.define('astro-island', class extends HTMLElement {}) // ñ";
    const html = `<head><script>${tema}</script></head><body><script type="module">${isla}</script></body>`;
    expect(await hashesDeScriptsInline(html)).toEqual([sha256(tema), sha256(isla)]);
  });

  it("ignora los scripts con src y los vacíos, y no repite hashes", async () => {
    const html = '<script type="module" src="/_astro/x.js"></script><script> </script><script>a()</script><SCRIPT>a()</SCRIPT>';
    expect(await hashesDeScriptsInline(html)).toEqual([sha256("a()")]);
  });
});

describe("construirCsp", () => {
  it("no permite scripts inline sin hash ni ser embebida en frames", () => {
    const csp = construirCsp([]);
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
  });

  it("agrega cada hash entre comillas a script-src", () => {
    expect(construirCsp(["sha256-a", "sha256-b"])).toContain("script-src 'self' 'sha256-a' 'sha256-b';");
  });

  it("permite las fuentes de Google y los escudos remotos", () => {
    const csp = construirCsp([]);
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp).toContain("img-src 'self' data: https:");
  });
});

describe("conHeadersDeSeguridad", () => {
  it("HTML: headers fijos + CSP con los hashes, sin tocar estado, cuerpo ni otros headers", async () => {
    const html = "<html><script>x()</script></html>";
    const res = await conHeadersDeSeguridad(
      new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(html);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    for (const [nombre, valor] of Object.entries(HEADERS_FIJOS)) expect(res.headers.get(nombre)).toBe(valor);
    expect(res.headers.get("Content-Security-Policy")).toContain(`'${sha256("x()")}'`);
  });

  it("JSON: headers fijos sin CSP y el cuerpo intacto", async () => {
    const res = await conHeadersDeSeguridad(Response.json({ error: "Unauthorized" }, { status: 401 }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.has("Content-Security-Policy")).toBe(false);
  });

  it("redirecciones (headers inmutables): conserva Location", async () => {
    const res = await conHeadersDeSeguridad(Response.redirect("https://fisture.test/login", 302));
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://fisture.test/login");
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });
});
