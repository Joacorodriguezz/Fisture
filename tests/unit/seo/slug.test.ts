// URLs con nombre de equipos y ligas (docs/33 D9): slug estable, sin colisiones y nunca con forma de id.
import { describe, expect, it } from "vitest";
import { asignarSlugs, basesDeSlug, esReservado, pareceUuid, rangoDeSlug, resolverSlug, slugificar } from "../../../src/lib/slug";

describe("slugificar", () => {
  it("pasa a minúsculas y quita tildes y diacríticos", () => {
    expect(slugificar("Atlético Tucumán")).toBe("atletico-tucuman");
    expect(slugificar("Deportivo Táchira")).toBe("deportivo-tachira");
    expect(slugificar("Grêmio")).toBe("gremio");
    expect(slugificar("São Paulo")).toBe("sao-paulo");
  });

  it("convierte la ñ en n", () => {
    expect(slugificar("Ñublense")).toBe("nublense");
    expect(slugificar("Peñarol")).toBe("penarol");
  });

  it("reemplaza puntos y espacios por un solo guion y quita los apóstrofes, sin guiones en los extremos", () => {
    // El apóstrofe se quita, no separa: "ohiggins" y "newells", como los escribe la gente
    expect(slugificar("O'Higgins")).toBe("ohiggins");
    expect(slugificar("Newell’s Old Boys")).toBe("newells-old-boys");
    expect(slugificar("1. FC Köln")).toBe("1-fc-koln");
    expect(slugificar("  Brighton & Hove Albion  ")).toBe("brighton-hove-albion");
    expect(slugificar("--Liga -- Profesional--")).toBe("liga-profesional");
  });

  it("descompone letras que NFD no separa (ß, ø, æ, ł, đ)", () => {
    expect(slugificar("Borussia Mönchengladbach")).toBe("borussia-monchengladbach");
    expect(slugificar("Fußball")).toBe("fussball");
    expect(slugificar("Bodø/Glimt")).toBe("bodo-glimt");
    expect(slugificar("Łódź")).toBe("lodz");
  });

  it("un nombre sin letras ni números latinos no genera slug", () => {
    expect(slugificar("")).toBeNull();
    expect(slugificar("   ")).toBeNull();
    expect(slugificar("—·—")).toBeNull();
    expect(slugificar("北京国安")).toBeNull();
  });
});

describe("pareceUuid y esReservado", () => {
  it("reconoce la forma de un UUID en cualquier caja", () => {
    expect(pareceUuid("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(pareceUuid("123E4567-E89B-12D3-A456-426614174000")).toBe(true);
    expect(pareceUuid("123e4567-e89b-12d3-a456-426614174000-2")).toBe(false);
    expect(pareceUuid("river-plate")).toBe(false);
  });

  it("las rutas fijas bajo /equipos/ y /ligas/ y los UUID quedan reservados", () => {
    expect(esReservado("buscar")).toBe(true);
    expect(esReservado("index")).toBe(true);
    expect(esReservado("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(esReservado("buscar-2")).toBe(false);
    expect(esReservado("river")).toBe(false);
  });
});

describe("resolverSlug", () => {
  it("usa el slug base si está libre", () => {
    expect(resolverSlug("River Plate", "Argentina", new Set())).toBe("river-plate");
  });

  it("si choca, prueba con el país", () => {
    expect(resolverSlug("Liverpool", "Uruguay", new Set(["liverpool"]))).toBe("liverpool-uruguay");
  });

  it("si choca con el país o no hay país, usa un sufijo numérico desde 2", () => {
    expect(resolverSlug("Liverpool", null, new Set(["liverpool"]))).toBe("liverpool-2");
    expect(resolverSlug("Liverpool", "Uruguay", new Set(["liverpool", "liverpool-uruguay"]))).toBe("liverpool-2");
    expect(resolverSlug("Liverpool", null, new Set(["liverpool", "liverpool-2", "liverpool-3"]))).toBe("liverpool-4");
  });

  it("no repite el país si el nombre ya termina con él", () => {
    expect(resolverSlug("Primera División Chile", "Chile", new Set(["primera-division-chile"]))).toBe("primera-division-chile-2");
  });

  it("un país que no genera slug cuenta como sin país", () => {
    expect(resolverSlug("Liverpool", "—", new Set(["liverpool"]))).toBe("liverpool-2");
  });

  it("no usa una ruta fija ni la forma de un UUID", () => {
    expect(resolverSlug("Buscar", "Argentina", new Set())).toBe("buscar-argentina");
    expect(resolverSlug("Index", null, new Set())).toBe("index-2");
    expect(resolverSlug("123e4567-e89b-12d3-a456-426614174000", null, new Set())).toBe("123e4567-e89b-12d3-a456-426614174000-2");
  });

  it("devuelve null si el nombre no genera slug", () => {
    expect(resolverSlug("北京国安", "China", new Set())).toBeNull();
  });
});

describe("asignarSlugs", () => {
  it("asigna en orden y reserva cada slug para las filas siguientes (nombres repetidos)", () => {
    const tomados = new Set<string>();
    const asignados = asignarSlugs(
      [
        { id: "a", name: "Liverpool", country: "Inglaterra" },
        { id: "b", name: "Liverpool", country: "Uruguay" },
        { id: "c", name: "Liverpool", country: null },
        { id: "d", name: "北京国安", country: null },
      ],
      tomados
    );
    expect([...asignados]).toEqual([
      ["a", "liverpool"],
      ["b", "liverpool-uruguay"],
      ["c", "liverpool-2"],
    ]);
    expect(tomados).toEqual(new Set(["liverpool", "liverpool-uruguay", "liverpool-2"]));
  });

  it("es determinístico: los mismos datos dan los mismos slugs", () => {
    const filas = [
      { id: "a", name: "Racing Club", country: "Argentina" },
      { id: "b", name: "Racing Club", country: "Uruguay" },
    ];
    expect([...asignarSlugs(filas, new Set())]).toEqual([...asignarSlugs(filas, new Set())]);
  });
});

describe("basesDeSlug y rangoDeSlug", () => {
  it("junta los slugs base sin repetir y sin los nombres vacíos", () => {
    expect(basesDeSlug([{ name: "Liverpool" }, { name: "Liverpool" }, { name: "Peñarol" }, { name: "—" }])).toEqual(["liverpool", "penarol"]);
  });

  it("el rango cubre el slug base y sus variantes con guion, no otros nombres que empiecen igual", () => {
    const [desde, hasta] = rangoDeSlug("river");
    const dentro = (s: string) => s >= desde && s < hasta;
    expect(dentro("river")).toBe(true);
    expect(dentro("river-2")).toBe(true);
    expect(dentro("river-argentina")).toBe(true);
    expect(dentro("riverside")).toBe(false);
    expect(dentro("river0")).toBe(false);
    expect(dentro("rive")).toBe(false);
  });
});
