import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { LEAGUES_CONFIG } from "../../src/lib/data-providers/types";
import { LOGOS_PROPIOS, logoDeCompetencia } from "../../src/lib/logos-competencias";

describe("logos propios de las competencias", () => {
  it("cada logo declarado existe en public/", () => {
    for (const [id, ruta] of Object.entries(LOGOS_PROPIOS)) {
      expect(existsSync(join(process.cwd(), "public", ruta)), `${id}: ${ruta}`).toBe(true);
    }
  });

  it("solo se declaran competencias que existen en la configuración", () => {
    const ids = new Set(LEAGUES_CONFIG.map((l) => l.externalId));
    for (const id of Object.keys(LOGOS_PROPIOS)) expect(ids.has(id), id).toBe(true);
  });

  it("todas las destacadas tienen logo propio salvo las Eliminatorias", () => {
    const sin = LEAGUES_CONFIG.filter((l) => l.destacada && !LOGOS_PROPIOS[l.externalId]).map((l) => l.externalId);
    expect(sin).toEqual(["fifa.worldq.conmebol"]);
  });

  it("el logo propio gana sobre ESPN; sin propio se usa ESPN; sin ninguno, null", () => {
    expect(logoDeCompetencia("arg.1", "https://espn/1.png")).toBe("/logos/competencias/arg.1.png");
    expect(logoDeCompetencia("bol.1")).toBe("/logos/competencias/bol.1.svg");
    expect(logoDeCompetencia("fifa.worldq.conmebol", "https://espn/65.png")).toBe("https://espn/65.png");
    expect(logoDeCompetencia("fifa.worldq.conmebol", undefined)).toBeNull();
  });
});
