// Configuración de competencias (docs/22): qué se lista, en qué orden se sincroniza y cómo se parte en lotes.
import { describe, expect, it } from "vitest";
import { COMPETENCIAS_POR_LOTE, LEAGUES_CONFIG, lotesDeSync } from "../../src/lib/data-providers";
import { partirEtapa } from "../../src/lib/data-providers/espn";

describe("competencias configuradas", () => {
  it("solo las ligas y las cinco copas internacionales grandes son destacadas", () => {
    const destacadas = LEAGUES_CONFIG.filter((l) => l.destacada).map((l) => l.externalId);
    expect(destacadas).toEqual([
      "eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "arg.1", "bra.1",
      "uru.1", "col.1", "chi.1", "ecu.1", "par.1", "per.1", "bol.1", "ven.1",
      "uefa.champions", "uefa.europa", "uefa.europa.conf", "conmebol.libertadores", "conmebol.sudamericana",
      "fifa.worldq.conmebol",
    ]);
  });

  it("todas las ligas son destacadas", () => {
    expect(LEAGUES_CONFIG.filter((l) => l.tipo === "liga").every((l) => l.destacada)).toBe(true);
  });

  it.each([
    ["Inglaterra", ["eng.fa", "eng.league_cup", "eng.charity"]],
    ["España", ["esp.copa_del_rey", "esp.super_cup"]],
    ["Italia", ["ita.coppa_italia", "ita.super_cup"]],
    ["Alemania", ["ger.dfb_pokal", "ger.super_cup"]],
    ["Francia", ["fra.coupe_de_france", "fra.super_cup"]],
    ["Argentina", ["arg.copa", "arg.supercopa", "arg.supercopa.internacional", "arg.trofeo_de_la_campeones"]],
    ["Brasil", ["bra.copa_do_brazil", "bra.supercopa_do_brazil"]],
  ])("incluye las copas nacionales de %s sin listarlas", (_pais, slugs) => {
    for (const slug of slugs) {
      expect(LEAGUES_CONFIG.find((l) => l.externalId === slug)).toMatchObject({ tipo: "copa", destacada: false });
    }
  });

  // docs/32 Fase A: las 10 ligas de CONMEBOL son destacadas y sus copas nacionales no
  it("las 10 ligas de CONMEBOL son destacadas", () => {
    const sudamericanas = ["arg.1", "bra.1", "uru.1", "col.1", "chi.1", "ecu.1", "par.1", "per.1", "bol.1", "ven.1"];
    for (const slug of sudamericanas) {
      expect(LEAGUES_CONFIG.find((l) => l.externalId === slug)).toMatchObject({ tipo: "liga", destacada: true, region: "sudamerica" });
    }
  });

  it.each([
    ["Colombia", ["col.copa", "col.superliga"]],
    ["Chile", ["chi.copa_chi", "chi.super_cup"]],
    ["Ecuador", ["ecu.supercopa"]],
    ["Paraguay", ["par.1.supercopa"]],
    ["Bolivia", ["bol.copa", "bol.ply.rel"]],
  ])("incluye las copas nacionales de %s sin listarlas", (pais, slugs) => {
    for (const slug of slugs) {
      expect(LEAGUES_CONFIG.find((l) => l.externalId === slug)).toMatchObject({ tipo: "copa", destacada: false, country: pais });
    }
  });

  // docs/32 Fase B: las selecciones entran por las Eliminatorias (plantel fijo); el resto son copas no destacadas
  it("las Eliminatorias son destacadas, de plantel fijo y en español", () => {
    expect(LEAGUES_CONFIG.find((l) => l.externalId === "fifa.worldq.conmebol")).toMatchObject({
      tipo: "copa", destacada: true, country: "Sudamérica", region: "sudamerica", participantes: "plantel-fijo", idioma: "es",
    });
  });

  it.each(["fifa.friendly", "conmebol.america"])("%s es una copa no destacada en español", (slug) => {
    expect(LEAGUES_CONFIG.find((l) => l.externalId === slug)).toMatchObject({ tipo: "copa", destacada: false, idioma: "es" });
  });

  it("el Mundial (fifa.world) no se sincroniza por ahora", () => {
    expect(LEAGUES_CONFIG.some((l) => l.externalId === "fifa.world")).toBe(false);
  });

  // D5: el nombre de una selección no puede alternar entre idiomas entre un sync y otro
  it("toda competencia donde puede aparecer una selección declara idioma es", () => {
    const deSelecciones = /^(fifa\.(world|friendly|worldq)|conmebol\.america|uefa\.(euro|nations)(\.|$)|concacaf\.|afc\.|caf\.)/;
    const candidatas = LEAGUES_CONFIG.filter((l) => deSelecciones.test(l.externalId));
    expect(candidatas.length).toBeGreaterThanOrEqual(3);
    expect(candidatas.every((l) => l.idioma === "es")).toBe(true);
    // y ninguna competencia de clubes cambia de idioma
    expect(LEAGUES_CONFIG.filter((l) => l.idioma === "es").map((l) => l.externalId).sort()).toEqual(
      candidatas.map((l) => l.externalId).sort()
    );
  });

  it("la Recopa y la Supercopa de la UEFA siguen sincronizándose pero no se listan", () => {
    for (const slug of ["conmebol.recopa", "uefa.super_cup"]) {
      expect(LEAGUES_CONFIG.find((l) => l.externalId === slug)).toMatchObject({ destacada: false });
    }
  });

  it("no repite competencias", () => {
    const ids = LEAGUES_CONFIG.map((l) => l.externalId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("ordena ligas, después copas destacadas y al final las demás", () => {
    const rango = (l: (typeof LEAGUES_CONFIG)[number]) => (l.tipo === "liga" ? 0 : l.destacada ? 1 : 2);
    const rangos = LEAGUES_CONFIG.map(rango);
    expect(rangos).toEqual([...rangos].sort((a, b) => a - b));
  });
});

describe("lotes del sync", () => {
  it("cubren todas las competencias, en orden y sin superar el tamaño", () => {
    const lotes = lotesDeSync();
    expect(lotes.flat()).toEqual(LEAGUES_CONFIG);
    expect(lotes.every((l) => l.length > 0 && l.length <= COMPETENCIAS_POR_LOTE)).toBe(true);
  });

  // docs/32 §4.4: el pedido extra de /teams no puede juntarse con otro en el mismo lote
  it("ningún lote tiene más de una competencia de plantel fijo", () => {
    for (const lote of lotesDeSync()) {
      expect(lote.filter((l) => l.participantes === "plantel-fijo").length).toBeLessThanOrEqual(1);
    }
  });

  it("parte una lista arbitraria", () => {
    expect(lotesDeSync(LEAGUES_CONFIG.slice(0, 7), 3).map((l) => l.length)).toEqual([3, 3, 1]);
    expect(lotesDeSync([], 3)).toEqual([]);
  });
});

describe("partirEtapa", () => {
  it.each([
    ["apertura---round-of-16", { torneo: "Apertura", etapa: "round-of-16" }],
    ["taca-rio---semifinals", { torneo: "Taça Rio", etapa: "semifinals" }],
    ["copa-desconocida---final", { torneo: "Copa Desconocida", etapa: "final" }],
    ["2025-argentine-trofeo-de-campeones---final", { torneo: null, etapa: "final" }],
    ["round-of-32", { torneo: null, etapa: "round-of-32" }],
  ])("%s", (slug, esperado) => {
    expect(partirEtapa(slug)).toEqual(esperado);
  });
});
