import { describe, expect, it } from "vitest";
import { urlEscudo } from "../../src/lib/escudo";

const ESPN = "https://a.espncdn.com/i/teamlogos/soccer/500/160.png";

describe("urlEscudo", () => {
  it("pide a ESPN la versión reducida al doble del tamaño mostrado (pantallas de alta densidad)", () => {
    expect(urlEscudo(ESPN, 36)).toBe("https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/160.png&w=96&h=96");
    expect(urlEscudo(ESPN, 48)).toBe("https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/160.png&w=96&h=96");
    expect(urlEscudo(ESPN, 72)).toBe("https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/160.png&w=192&h=192");
  });

  it("usa pocos anchos fijos para que el mismo escudo se cachee una sola vez entre páginas", () => {
    const anchos = new Set([32, 34, 36, 40, 44].map((t) => new URL(urlEscudo(ESPN, t)).searchParams.get("w")));
    expect([...anchos]).toEqual(["96"]);
  });

  it("deja el original cuando el escudo se muestra grande: la reducción ya no ahorra", () => {
    expect(urlEscudo(ESPN, 112)).toBe(ESPN);
    expect(urlEscudo(ESPN, 160)).toBe(ESPN);
  });

  it("vale para las banderas de selecciones", () => {
    expect(urlEscudo("https://a.espncdn.com/i/teamlogos/countries/500/arg.png", 44))
      .toBe("https://a.espncdn.com/combiner/i?img=/i/teamlogos/countries/500/arg.png&w=96&h=96");
  });

  it("no toca lo que no es un logo de ESPN, ni una URL ya reducida o con parámetros", () => {
    for (const src of [
      "https://media.api-sports.io/football/teams/435.png",
      "https://a.espncdn.com/combiner/i?img=/i/teamlogos/soccer/500/160.png&w=96&h=96",
      "https://a.espncdn.com/i/teamlogos/soccer/500/160.png?v=2",
      "https://a.espncdn.com.evil.test/i/teamlogos/soccer/500/160.png",
      "http://a.espncdn.com/i/teamlogos/soccer/500/160.png",
      "/escudos/local.svg",
    ]) expect(urlEscudo(src, 36)).toBe(src);
  });
});
