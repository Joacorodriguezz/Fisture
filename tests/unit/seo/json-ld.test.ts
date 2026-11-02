import { describe, expect, it } from "vitest";
import {
  escaparMarkdown,
  escaparXml,
  jsonLdEquipo,
  jsonLdLiga,
  jsonLdMigas,
  jsonLdPartido,
  jsonLdSitio,
  recortarDescripcion,
  rutaPublica,
  serializarJsonLd,
  urlCanonica,
} from "../../../src/lib/seo";

const BASE = "https://fisture.test";
const river = { id: "river", name: "River Plate", logo: "https://img.test/river.png" };
const boca = { id: "boca", name: "Boca Juniors", logo: null };
const liga = { id: "lpf", name: "Liga Profesional", country: "Argentina" };
const match = { id: "superclasico", dateTime: new Date("2026-11-01T20:00:00Z"), venue: "Monumental", status: "scheduled", round: "Fecha 15" };

describe("serializarJsonLd", () => {
  it("escapa < para que el contenido no pueda cerrar el <script>", () => {
    const json = serializarJsonLd({ name: "</script><script>alert(1)</script>" });
    expect(json).not.toContain("<");
    expect(JSON.parse(json).name).toBe("</script><script>alert(1)</script>");
  });
});

describe("jsonLdSitio", () => {
  it("WebSite, Organization y WebApplication con la base sin barra duplicada", () => {
    const ld = jsonLdSitio(`${BASE}/`);
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@graph"].map((n) => n["@type"])).toEqual(["WebSite", "Organization", "WebApplication"]);
    expect(ld["@graph"][0].url).toBe(`${BASE}/`);
  });
});

describe("jsonLdPartido", () => {
  it("SportsEvent con fechas ISO, sede, equipos y la liga como superEvent", () => {
    const ld = jsonLdPartido(BASE, { match, homeTeam: river, awayTeam: boca, league: liga });
    expect(ld).toMatchObject({
      "@type": "SportsEvent",
      name: "River Plate vs Boca Juniors",
      url: `${BASE}/partidos/superclasico`,
      startDate: "2026-11-01T20:00:00.000Z",
      endDate: "2026-11-01T22:00:00.000Z",
      eventStatus: "https://schema.org/EventScheduled",
      location: { "@type": "Place", name: "Monumental" },
      homeTeam: { "@type": "SportsTeam", name: "River Plate", url: `${BASE}/equipos/river`, logo: river.logo },
      awayTeam: { name: "Boca Juniors", url: `${BASE}/equipos/boca` },
      superEvent: { name: "Liga Profesional", url: `${BASE}/ligas/lpf` },
      image: [river.logo],
    });
    expect(ld.description).toContain("(Fecha 15)");
    expect(ld.awayTeam).not.toHaveProperty("logo");
  });

  it("sin sede no inventa location y mapea postergado y cancelado", () => {
    const sinSede = jsonLdPartido(BASE, { match: { ...match, venue: null, status: "postponed" }, homeTeam: boca, awayTeam: boca, league: liga });
    expect(sinSede).not.toHaveProperty("location");
    expect(sinSede).not.toHaveProperty("image");
    expect(sinSede.eventStatus).toBe("https://schema.org/EventPostponed");
    expect(jsonLdPartido(BASE, { match: { ...match, status: "cancelled" }, homeTeam: river, awayTeam: boca, league: liga }).eventStatus)
      .toBe("https://schema.org/EventCancelled");
  });
});

describe("jsonLdEquipo y jsonLdLiga", () => {
  it("SportsTeam con su liga como memberOf (opcional)", () => {
    expect(jsonLdEquipo(BASE, river, liga)).toMatchObject({ "@type": "SportsTeam", memberOf: { name: "Liga Profesional", url: `${BASE}/ligas/lpf` } });
    expect(jsonLdEquipo(BASE, river, null)).not.toHaveProperty("memberOf");
  });

  it("SportsOrganization con sus equipos", () => {
    const ld = jsonLdLiga(BASE, liga, [river, boca]);
    expect(ld).toMatchObject({ "@type": "SportsOrganization", name: "Liga Profesional", areaServed: "Argentina" });
    expect(ld.member.map((m) => m.url)).toEqual([`${BASE}/equipos/river`, `${BASE}/equipos/boca`]);
  });
});

describe("jsonLdMigas", () => {
  it("BreadcrumbList numerado desde 1 con URLs canónicas", () => {
    const ld = jsonLdMigas(`${BASE}/`, [{ nombre: "Ligas", ruta: "/ligas/" }, { nombre: "Liga Profesional", ruta: "/ligas/lpf" }]);
    expect(ld.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Ligas", item: `${BASE}/ligas` },
      { "@type": "ListItem", position: 2, name: "Liga Profesional", item: `${BASE}/ligas/lpf` },
    ]);
  });
});

describe("rutaPublica", () => {
  it("codifica el id igual que la URL que llega a Astro (canónica)", () => {
    const ruta = rutaPublica("equipos", "boca juniors/ñ&?");
    expect(ruta).toBe("/equipos/boca%20juniors%2F%C3%B1%26%3F");
    expect(urlCanonica(BASE, new URL(`${BASE}${ruta}`).pathname)).toBe(`${BASE}${ruta}`);
  });

  it("los JSON-LD usan la ruta codificada en todas las URLs", () => {
    const raro = { id: "a b&c", name: "Equipo raro", logo: null };
    const ligaRara = { ...liga, id: "liga/1" };
    const ld = jsonLdPartido(BASE, { match: { ...match, id: "p 1" }, homeTeam: raro, awayTeam: boca, league: ligaRara });
    expect(ld.url).toBe(`${BASE}/partidos/p%201`);
    expect(ld.homeTeam.url).toBe(`${BASE}/equipos/a%20b%26c`);
    expect(ld.superEvent.url).toBe(`${BASE}/ligas/liga%2F1`);
    expect(jsonLdEquipo(BASE, raro, ligaRara).memberOf?.url).toBe(`${BASE}/ligas/liga%2F1`);
    expect(jsonLdLiga(BASE, ligaRara, [raro]).url).toBe(`${BASE}/ligas/liga%2F1`);
  });
});

describe("jsonLdPartido: campos recomendados por Google", () => {
  it("los equipos también van como performer y no se inventan organizer, offers ni dirección", () => {
    const ld = jsonLdPartido(BASE, { match, homeTeam: river, awayTeam: boca, league: liga });
    expect(ld.performer).toEqual([ld.homeTeam, ld.awayTeam]);
    expect(ld).not.toHaveProperty("organizer");
    expect(ld).not.toHaveProperty("offers");
    expect(ld.location).not.toHaveProperty("address");
    expect(ld.startDate).toMatch(/Z$/);
  });
});

describe("recortarDescripcion", () => {
  it("deja igual un texto corto y normaliza espacios", () => {
    expect(recortarDescripcion("  Fixture  de\nRiver ")).toBe("Fixture de River");
  });

  it("corta en un espacio, sin puntuación colgando, y no pasa el máximo", () => {
    const largo = `Fixture de Club Atlético Independiente (Liga Profesional Argentina): próximo partido ${"xx ".repeat(60)}`;
    const corto = recortarDescripcion(largo);
    expect(corto.length).toBeLessThanOrEqual(160);
    expect(corto.endsWith("xx…")).toBe(true);
    expect(recortarDescripcion("Hola mundo, entero y algo", 13)).toBe("Hola mundo…");
  });

  it("si no hay espacios útiles corta en el máximo", () => {
    expect(recortarDescripcion("a".repeat(200))).toBe(`${"a".repeat(159)}…`);
  });
});

describe("escapes", () => {
  it("escaparXml cubre &, <, >, comillas y apóstrofo", () => {
    expect(escaparXml(`a&b<c>"d'`)).toBe("a&#38;b&#60;c&#62;&#34;d&#39;");
  });

  it("escaparMarkdown escapa corchetes, barras y énfasis para el texto de un link", () => {
    expect(escaparMarkdown("Copa [A](x) *B* _c_ `d` \\")).toBe("Copa \\[A\\](x) \\*B\\* \\_c\\_ \\`d\\` \\\\");
  });
});
