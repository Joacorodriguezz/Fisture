import { describe, expect, it } from "vitest";
import { baseUrl, normalizarRuta, urlCanonica } from "../../../src/lib/seo";

describe("baseUrl", () => {
  it("quita las barras finales de PUBLIC_APP_URL", () => {
    expect(baseUrl("https://fisture.test/")).toBe("https://fisture.test");
    expect(baseUrl("https://fisture.test///")).toBe("https://fisture.test");
    expect(baseUrl("https://fisture.test")).toBe("https://fisture.test");
  });
});

describe("normalizarRuta", () => {
  it("quita la barra final salvo en la raíz", () => {
    expect(normalizarRuta("/hoy/")).toBe("/hoy");
    expect(normalizarRuta("/ligas/12/")).toBe("/ligas/12");
    expect(normalizarRuta("/hoy")).toBe("/hoy");
    expect(normalizarRuta("/")).toBe("/");
  });
});

describe("urlCanonica", () => {
  it("arma la URL absoluta sin barra duplicada ni barra final", () => {
    expect(urlCanonica("https://fisture.test/", "/hoy/")).toBe("https://fisture.test/hoy");
    expect(urlCanonica("https://fisture.test", "/hoy")).toBe("https://fisture.test/hoy");
  });

  it("deja la raíz con su barra", () => {
    expect(urlCanonica("https://fisture.test", "/")).toBe("https://fisture.test/");
    expect(urlCanonica("https://fisture.test/", "/")).toBe("https://fisture.test/");
  });
});
