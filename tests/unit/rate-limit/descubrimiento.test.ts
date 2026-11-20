import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const RAIZ = join(process.cwd(), "src", "pages", "api");
const archivos = (readdirSync(RAIZ, { recursive: true }) as string[]).map((f) => f.replaceAll("\\", "/")).filter((f) => f.endsWith(".ts"));

describe("RL16: descubrimiento de handlers", () => {
  it("encuentra los handlers de pages/api", () => {
    expect(archivos.length).toBeGreaterThan(10);
  });

  it.each(archivos)("%s exporta cada método envuelto con withApi", (archivo) => {
    const fuente = readFileSync(join(RAIZ, archivo), "utf8");
    const exportados = [...fuente.matchAll(/^export (?:const|async function|function) (GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ALL)\b(.*)$/gm)];
    expect(exportados.length).toBeGreaterThan(0);
    for (const [, metodo, resto] of exportados) {
      expect(resto, `${archivo}: ${metodo} sin withApi`).toMatch(/=\s*(?:\w+:\s*)?withApi\(|APIRoute\s*=\s*withApi\(/);
    }
  });

  it("OR14: esMismoOrigen se define una sola vez en el repo", () => {
    const definiciones: string[] = [];
    const recorrer = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const ruta = join(dir, e.name);
        if (e.isDirectory()) recorrer(ruta);
        else if (/\.(ts|tsx|astro)$/.test(e.name) && /function esMismoOrigen\b/.test(readFileSync(ruta, "utf8"))) definiciones.push(ruta);
      }
    };
    recorrer(join(process.cwd(), "src"));
    expect(definiciones).toHaveLength(1);
  });

  it("los handlers de login y callback declaran su política de límite", () => {
    const login = readFileSync(join(RAIZ, "auth/login/[provider].ts"), "utf8");
    const callback = readFileSync(join(RAIZ, "auth/callback/[provider].ts"), "utf8");
    expect(login).toMatch(/rateLimit:\s*\[\s*"login"/);
    expect(callback).toMatch(/rateLimit:\s*\[\s*"oauth_callback"/);
    expect(login).toMatch(/rateLimitRedirect:\s*"\/login\?error=rate_limited"/);
    expect(callback).toMatch(/rateLimitRedirect:\s*"\/login\?error=rate_limited"/);
  });

  // docs/37 §3.4: los handlers del prode declaran su política explícita. Una mutación sin política cae en
  // el límite genérico, que no protege los códigos de invitación de la fuerza bruta.
  const prode = archivos.filter((f) => f.startsWith("prode/"));

  it("encuentra los endpoints del prode", () => {
    expect(prode.length).toBeGreaterThan(0);
  });

  it.each(prode)("%s declara rateLimit en cada withApi", (archivo) => {
    const fuente = readFileSync(join(RAIZ, archivo), "utf8");
    const envolturas = fuente.match(/withApi\(/g)?.length ?? 0;
    const politicas = fuente.match(/rateLimit:\s*\[\s*"/g)?.length ?? 0;
    expect(
      politicas,
      `${archivo}: cada withApi(handler, { rateLimit: [...] }) del prode necesita políticas de lib/rate-limit/policies.ts (docs/37 §3.4)`
    ).toBe(envolturas);
  });

  it("unirse a un grupo del prode se limita por IP y por usuario", () => {
    const fuente = readFileSync(join(RAIZ, "prode/unirse.ts"), "utf8");
    expect(fuente).toMatch(/rateLimit:\s*\[\s*"prode_unirse_ip",\s*"prode_unirse"\s*\]/);
  });

  const admin = archivos.filter((f) => f.startsWith("admin/"));

  it("encuentra los endpoints de admin", () => {
    expect(admin.length).toBeGreaterThan(0);
  });

  it.each(admin)("%s autoriza con verificarAdmin (cuenta los fallos de Bearer por IP)", (archivo) => {
    const fuente = readFileSync(join(RAIZ, archivo), "utf8");
    expect(fuente, `${archivo}: debe llamar a verificarAdmin`).toMatch(/\bverificarAdmin\(/);
    expect(fuente, `${archivo}: no debe usar isAdminAuthorized directo`).not.toMatch(/\bisAdminAuthorized\(/);
  });
});
