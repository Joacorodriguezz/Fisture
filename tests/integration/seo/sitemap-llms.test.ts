// sitemap.xml y llms.txt leen las páginas dinámicas (ligas, equipos, partidos) de D1.
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { relojFijo, AHORA, DIA_MS } from "../../helpers/clock";
import { leagues, matches } from "../../../drizzle/schema";
import { GET as getSitemap } from "../../../src/pages/sitemap.xml";
import { GET as getLlms } from "../../../src/pages/llms.txt";
import { GET as getRobots } from "../../../src/pages/robots.txt";
import { getPaginasPublicas } from "../../../src/lib/db/queries";

const BASE = "https://fisture.test";
const RUTAS = ["/", "/ligas", "/partidos", "/calendario", "/hoy", "/equipos/buscar", "/privacidad", "/terminos"];

describe("sitemap.xml y llms.txt", () => {
  const t = useTestDb();
  relojFijo();

  const ctx = (publicAppUrl: string = BASE) =>
    ({ locals: { runtime: { env: { PUBLIC_APP_URL: publicAppUrl, DB: t.DB } } } }) as any;

  beforeEach(async () => {
    await seedApp(t.db);
  });

  describe("GET /sitemap.xml", () => {
    it("responde 200 con XML y caché de una hora", async () => {
      const res = await getSitemap(ctx());
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("application/xml; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
      expect(await res.text()).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    });

    it("codifica los ids como la canónica y escapa el XML", async () => {
      await t.db.insert(leagues).values({ id: "liga&co's", externalId: "test:rara", name: "Rara", country: "Argentina", season: 2026 });
      const xml = await (await getSitemap(ctx())).text();
      expect(xml).toContain(`<loc>${BASE}/ligas/liga%26co&#39;s</loc>`);
      expect(xml).not.toMatch(/&(?!#\d+;)/);
    });

    it("lista las páginas públicas fijas", async () => {
      const xml = await (await getSitemap(ctx())).text();
      for (const ruta of RUTAS) expect(xml).toContain(`<loc>${BASE}${ruta}</loc>`);
    });

    it("lista ligas activas, sus equipos y los partidos próximos", async () => {
      const xml = await (await getSitemap(ctx())).text();
      expect(xml).toContain(`<loc>${BASE}/ligas/test-league</loc>`);
      // Equipos sin lastmod (la fila de teams no refleja cuándo cambia su fixture); partidos con lastmod
      expect(xml).toContain(`<url><loc>${BASE}/equipos/river</loc></url>`);
      expect(xml).toContain(`<url><loc>${BASE}/equipos/boca</loc></url>`);
      expect(xml).toMatch(new RegExp(`<loc>${BASE}/partidos/superclasico</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
    });

    it("no lista partidos pasados ni lo de ligas inactivas", async () => {
      await t.db.update(matches).set({ dateTime: new Date(AHORA.getTime() - DIA_MS) }).where(eq(matches.id, "superclasico"));
      expect(await (await getSitemap(ctx())).text()).not.toContain("/partidos/superclasico");

      await t.db.update(leagues).set({ isActive: false }).where(eq(leagues.id, "test-league"));
      const xml = await (await getSitemap(ctx())).text();
      expect(xml).not.toContain("/ligas/test-league");
      expect(xml).not.toContain("/equipos/river");
    });

    it("no lista páginas personales ni de login", async () => {
      const xml = await (await getSitemap(ctx())).text();
      expect(xml).not.toContain("/configuracion");
      expect(xml).not.toContain("/login");
    });

    it("la base coincide con la línea Sitemap de robots.txt y no duplica la barra", async () => {
      for (const env of [BASE, `${BASE}/`, "https://otro.example"]) {
        const robots = await (await getRobots(ctx(env))).text();
        const base = robots.match(/^Sitemap: (.*)\/sitemap\.xml$/m)![1];
        const xml = await (await getSitemap(ctx(env))).text();
        expect(xml).toContain(`<loc>${base}/ligas</loc>`);
        expect(xml).not.toMatch(/https?:\/\/[^<]+\/\//);
      }
    });
  });

  describe("GET /llms.txt", () => {
    it("resume el sitio en markdown con las ligas activas y URLs absolutas", async () => {
      const res = await getLlms(ctx());
      expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
      expect(res.headers.get("Cache-Control")).toBe("public, max-age=3600");
      const texto = await res.text();
      expect(texto.startsWith("# FISTURE\n\n> ")).toBe(true);
      expect(texto).toContain(`- [Liga de prueba](${BASE}/ligas/test-league) (Argentina)`);
      expect(texto).toContain(`(${BASE}/hoy)`);
      expect(texto).not.toContain("/configuracion");
    });

    it("escapa el markdown del nombre y codifica el id de la liga", async () => {
      await t.db.insert(leagues).values({ id: "copa 1", externalId: "test:copa", name: "Copa [A] *B*", country: "Sudamérica", season: 2026 });
      const texto = await (await getLlms(ctx())).text();
      expect(texto).toContain(`- [Copa \\[A\\] \\*B\\*](${BASE}/ligas/copa%201) (Sudamérica)`);
    });
  });

  describe("getPaginasPublicas", () => {
    it("respeta la ventana de días", async () => {
      expect((await getPaginasPublicas(t.db, AHORA, 2)).partidos.map((p) => p.id)).toEqual(["superclasico"]);
      expect((await getPaginasPublicas(t.db, new Date(AHORA.getTime() + 2 * DIA_MS), 60)).partidos).toEqual([]);
    });
  });
});
