// Dominio único para buscadores (docs/29 C1)
import { describe, expect, it } from "vitest";
import { destinoDominioCanonico } from "../../../src/lib/seo";

const PROD = "https://fisture.com";
const destino = (url: string, metodo = "GET", entorno = "production", base = PROD) =>
  destinoDominioCanonico(new URL(url), metodo, entorno, base);

describe("destinoDominioCanonico", () => {
  it("redirige pages.dev, www y el alias de un deploy a la misma ruta y query en el dominio canónico", () => {
    expect(destino("https://fisture.pages.dev/ligas?x=1")).toBe("https://fisture.com/ligas?x=1");
    expect(destino("https://www.fisture.com/")).toBe("https://fisture.com/");
    expect(destino("https://abc123.fisture.pages.dev/equipos/river")).toBe("https://fisture.com/equipos/river");
  });

  it("pasa de http a https en el mismo host", () => {
    expect(destino("http://fisture.com/hoy")).toBe("https://fisture.com/hoy");
  });

  it("no redirige si ya está en el dominio canónico (con o sin barra final en PUBLIC_APP_URL)", () => {
    expect(destino("https://fisture.com/ligas")).toBeNull();
    expect(destino("https://fisture.com/ligas", "GET", "production", "https://fisture.com/")).toBeNull();
  });

  it("no toca staging, test ni dev", () => {
    expect(destino("https://development.fisture.pages.dev/ligas", "GET", "staging")).toBeNull();
    expect(destino("https://fisture.pages.dev/ligas", "GET", "test")).toBeNull();
    expect(destino("https://fisture.pages.dev/ligas", "GET", "")).toBeNull();
  });

  it("no toca la API, las mutaciones ni los pedidos locales", () => {
    expect(destino("https://fisture.pages.dev/api/health")).toBeNull();
    expect(destino("https://fisture.pages.dev/api")).toBeNull();
    expect(destino("https://fisture.pages.dev/ligas", "POST")).toBeNull();
    expect(destino("http://localhost:8788/ligas")).toBeNull();
    expect(destino("http://127.0.0.1:8788/ligas")).toBeNull();
  });

  it("HEAD se redirige igual que GET, y una /apis que no es la API también", () => {
    expect(destino("https://fisture.pages.dev/", "HEAD")).toBe("https://fisture.com/");
    expect(destino("https://fisture.pages.dev/apis")).toBe("https://fisture.com/apis");
  });

  it("con PUBLIC_APP_URL inválida no redirige (falla abierto: mejor duplicado que caído)", () => {
    expect(destino("https://fisture.pages.dev/ligas", "GET", "production", "no-es-url")).toBeNull();
  });
});
