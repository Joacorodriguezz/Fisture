import { describe, expect, it } from "vitest";
import { jsonLdEquipo, jsonLdLiga, jsonLdMigas, jsonLdPartido, jsonLdSitio, serializarJsonLd } from "../../../src/lib/seo";

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
