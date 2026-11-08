import { describe, expect, it } from "vitest";
import { GET as getRobots } from "../../../src/pages/robots.txt";

const BASE = "https://fisture.test";

function ctx(publicAppUrl: string = BASE) {
  return {
    request: new Request(`${BASE}/robots.txt`),
    url: new URL(`${BASE}/robots.txt`),
    params: {},
    locals: { runtime: { env: { PUBLIC_APP_URL: publicAppUrl } } },
  } as any;
}

async function lineas(publicAppUrl?: string): Promise<string[]> {
  const texto = await (await getRobots(ctx(publicAppUrl))).text();
  return texto.split(/\r?\n/).map((l) => l.trim());
}

describe("GET /robots.txt", () => {
  it("responde 200 como texto plano", async () => {
    const res = await getRobots(ctx());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^text\/plain/);
  });

  it("permite el rastreo general", async () => {
    const l = await lineas();
    expect(l).toContain("User-agent: *");
    expect(l).toContain("Allow: /");
  });

  it("bloquea la API y configuración, pero permite leer el noindex de login", async () => {
    const l = await lineas();
    expect(l).toContain("Disallow: /api/");
    expect(l).toContain("Disallow: /configuracion");
    expect(l).not.toContain("Disallow: /login");
  });

  it("apunta al sitemap con la base de PUBLIC_APP_URL", async () => {
    expect(await lineas()).toContain(`Sitemap: ${BASE}/sitemap.xml`);
    expect(await lineas("https://otro.example")).toContain("Sitemap: https://otro.example/sitemap.xml");
  });

  it("no duplica la barra si PUBLIC_APP_URL termina en /", async () => {
    expect(await lineas(`${BASE}/`)).toContain(`Sitemap: ${BASE}/sitemap.xml`);
  });
});

describe("GET /robots.txt en staging (docs/26)", () => {
  it("bloquea todo el sitio y no publica el sitemap", async () => {
    const res = await getRobots({ ...ctx(), locals: { runtime: { env: { PUBLIC_APP_URL: BASE, ENVIRONMENT: "staging" } } } });
    const texto = await res.text();
    expect(texto.split("\n")).toEqual(["User-agent: *", "Disallow: /", ""]);
    expect(texto).not.toContain("Sitemap");
  });
});
