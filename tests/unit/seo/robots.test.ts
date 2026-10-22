import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const robots = readFileSync(new URL("../../../public/robots.txt", import.meta.url), "utf8");
const lineas = robots.split(/\r?\n/).map((l) => l.trim());

describe("public/robots.txt", () => {
  it("permite el rastreo general", () => {
    expect(lineas).toContain("User-agent: *");
    expect(lineas).toContain("Allow: /");
  });

  it("bloquea la API y las páginas personales o de login", () => {
    expect(lineas).toContain("Disallow: /api/");
    expect(lineas).toContain("Disallow: /configuracion");
    expect(lineas).toContain("Disallow: /login");
  });

  it("apunta al sitemap", () => {
    expect(lineas).toContain("Sitemap: https://fisture.pages.dev/sitemap.xml");
  });
});
