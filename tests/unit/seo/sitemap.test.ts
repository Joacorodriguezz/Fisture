import { describe, expect, it } from "vitest";
import { GET } from "../../../src/pages/sitemap.xml";

const BASE = "https://fisture.test";
const RUTAS = ["/", "/ligas", "/partidos", "/calendario", "/hoy", "/privacidad", "/terminos"];

function ctx(publicAppUrl: string = BASE) {
  return {
    request: new Request(`${BASE}/sitemap.xml`),
    url: new URL(`${BASE}/sitemap.xml`),
    params: {},
    locals: { runtime: { env: { PUBLIC_APP_URL: publicAppUrl } } },
  } as any;
}

describe("GET /sitemap.xml", () => {
  it("responde 200 con XML", async () => {
    const res = await GET(ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/xml");
  });

  it("lista las páginas públicas con la base de PUBLIC_APP_URL", async () => {
    const xml = await (await GET(ctx())).text();
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    for (const ruta of RUTAS) {
      expect(xml).toContain(`<loc>${BASE}${ruta}</loc>`);
    }
  });

  it("no lista páginas personales ni de login", async () => {
    const xml = await (await GET(ctx())).text();
    expect(xml).not.toContain("/configuracion");
    expect(xml).not.toContain("/login");
  });

  it("no duplica la barra si PUBLIC_APP_URL termina en /", async () => {
    const xml = await (await GET(ctx(`${BASE}/`))).text();
    expect(xml).toContain(`<loc>${BASE}/ligas</loc>`);
    expect(xml).not.toContain(`${BASE}//`);
  });
});
