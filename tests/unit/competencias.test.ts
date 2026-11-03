// Configuración de competencias (docs/22): qué se lista, en qué orden se sincroniza y cómo se parte en lotes.
import { describe, expect, it } from "vitest";
import { COMPETENCIAS_POR_LOTE, LEAGUES_CONFIG, lotesDeSync } from "../../src/lib/data-providers";
import { partirEtapa } from "../../src/lib/data-providers/espn";

describe("competencias configuradas", () => {
  it("solo las ligas y las cinco copas internacionales grandes son destacadas", () => {
    const destacadas = LEAGUES_CONFIG.filter((l) => l.destacada).map((l) => l.externalId);
    expect(destacadas).toEqual([
      "eng.1", "esp.1", "ita.1", "ger.1", "fra.1", "arg.1", "bra.1",
      "uefa.champions", "uefa.europa", "uefa.europa.conf", "conmebol.libertadores", "conmebol.sudamericana",
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
