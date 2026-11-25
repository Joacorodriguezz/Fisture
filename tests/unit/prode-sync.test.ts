// scripts/prode-sync.mjs y .github/workflows/prode-sync.yml: disparan las pasadas del prode (docs/40 D4 y D6).
// Se prueban con un fetch falso: sin red ni cuenta de GitHub.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { correrPasada } from "../../scripts/prode-sync.mjs";
import { WORKFLOWS_PROGRAMADOS } from "../../scripts/keepalive.mjs";

const opciones = (fetchImpl: unknown) => ({
  appUrl: "https://app.test/",
  adminSecret: "s3",
  fetchImpl: fetchImpl as typeof fetch,
  esperar: vi.fn(async () => {}),
  log: vi.fn(),
});
const con = (...respuestas: Response[]) => vi.fn(async () => respuestas.shift() ?? new Response("sin más respuestas", { status: 500 }));

describe("correrPasada", () => {
  it("sin trabajo: un POST con el secret y nada más", async () => {
    const fetchImpl = con(Response.json({ success: true, trabajo: false }));
    expect(await correrPasada(opciones(fetchImpl))).toEqual({ trabajo: false });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { method: string; headers: Record<string, string> }];
    expect(url).toBe("https://app.test/api/admin/prode/sync");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer s3");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("con trabajo y run success: sin error", async () => {
    const o = opciones(con(Response.json({ success: true, trabajo: true, status: "success", partidos: 2 })));
    expect(await correrPasada(o)).toEqual({ trabajo: true });
  });

  it("un run partial o failed es una falla de una corrida con trabajo, sin reintento", async () => {
    for (const respuesta of [
      Response.json({ success: true, trabajo: true, status: "partial", error: "ESPN caído" }),
      Response.json({ success: false, trabajo: true, status: "failed", error: "ESPN caído" }, { status: 500 }),
    ]) {
      const fetchImpl = con(respuesta);
      expect(await correrPasada(opciones(fetchImpl))).toEqual({ trabajo: true, error: expect.stringContaining("ESPN caído") });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("reintenta un error de red o un 5xx sin respuesta del endpoint", async () => {
    const o = opciones(con(new Response("caído", { status: 503 }), Response.json({ success: true, trabajo: false })));
    expect(await correrPasada(o)).toEqual({ trabajo: false });
    expect(o.esperar).toHaveBeenCalledTimes(1);

    const red = vi.fn(async () => {
      throw new Error("sin red");
    });
    expect(await correrPasada(opciones(red))).toEqual({ trabajo: null, error: expect.stringContaining("sin red") });
    expect(red).toHaveBeenCalledTimes(3);
  });

  it("un 401 o un 429 fallan sin reintentar", async () => {
    for (const status of [401, 429]) {
      const fetchImpl = con(new Response("{}", { status }));
      expect(await correrPasada(opciones(fetchImpl))).toEqual({ trabajo: null, error: expect.stringContaining(String(status)) });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("una respuesta que no se entiende falla", async () => {
    const o = { ...opciones(vi.fn(async () => Response.json({ ok: 1 }))) };
    expect((await correrPasada(o)).error).toBeTruthy();
  });

  // El schedule corre desde development: hasta el release, producción todavía no tiene la ruta
  it("un 404 (ruta todavía no desplegada) avisa y no falla", async () => {
    const o = opciones(con(new Response("Not found", { status: 404 })));
    expect(await correrPasada(o)).toEqual({ trabajo: false });
    expect(o.log).toHaveBeenCalledWith(expect.stringContaining("::warning::"));
  });

  it("exige la URL y el secret", async () => {
    await expect(correrPasada({ adminSecret: "s" })).rejects.toThrow("appUrl");
    await expect(correrPasada({ appUrl: "https://app.test" })).rejects.toThrow("adminSecret");
  });
});

describe("prode-sync.yml", () => {
  const workflow = readFileSync(".github/workflows/prode-sync.yml", "utf8").replace(/\r\n/g, "\n");

  it("corre cada 15 minutos y a mano, sin pisarse y nunca en un fork", () => {
    expect(workflow).toContain('- cron: "*/15 * * * *"');
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("concurrency:");
    expect(workflow).toContain("if: github.repository == 'Joacorodriguezz/Fisture'");
  });

  it("el schedule va a producción; staging solo a mano y sin incidentes", () => {
    expect(workflow).toContain("inputs.entorno == 'staging' && secrets.STAGING_ADMIN_SECRET || secrets.ADMIN_SECRET");
    expect(workflow).toContain("inputs.entorno == 'staging' && 'https://development.fisture.pages.dev' || secrets.PUBLIC_APP_URL");
    expect(workflow.match(/inputs\.entorno != 'staging'/g)).toHaveLength(3);
  });

  it("abre y cierra su incidente, y consulta la espera solo con trabajo", () => {
    expect(workflow).toContain("node scripts/prode-sync.mjs");
    expect(workflow).toMatch(/steps\.pasada\.outcome == 'failure' && steps\.pasada\.outputs\.trabajo != 'false'[\s\S]*incidente\.sh abrir "Falla el sync del prode"/);
    expect(workflow).toMatch(/steps\.pasada\.outcome == 'success'[\s\S]*incidente\.sh cerrar "Falla el sync del prode"/);
    expect(workflow).toMatch(/steps\.pasada\.outputs\.trabajo == 'true'[\s\S]*node scripts\/prode-espera\.mjs/);
  });

  it("el keepalive lo reactiva si GitHub lo desactiva", () => {
    expect(WORKFLOWS_PROGRAMADOS).toContain("prode-sync.yml");
  });
});
