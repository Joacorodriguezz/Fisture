// scripts/prode-espera.mjs: avisa por issue cuando hay resultados del prode en espera (docs/40 D5).
// Se prueba con un fetch y un incidente.sh falsos: sin red ni cuenta de GitHub.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { avisarEspera, TITULO } from "../../scripts/prode-espera.mjs";

const status = (enEspera: unknown) => Response.json({ metricas: { prode: { automatizacion: { enEspera } } } });

const opciones = (fetchImpl: unknown) => ({
  appUrl: "https://app.test/",
  adminSecret: "s3",
  fetchImpl: fetchImpl as typeof fetch,
  incidente: vi.fn(async () => {}),
  esperar: vi.fn(async () => {}),
  log: vi.fn(),
});

describe("avisarEspera", () => {
  // Una sola vez: las pasadas del prode lo consultan seguido y no deben comentar cada vez
  it("con partidos en espera abre el incidente, consultando el status con el secret", async () => {
    const fetchImpl = vi.fn(async () => status(2));
    const o = opciones(fetchImpl);
    expect(await avisarEspera(o)).toBe(2);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, { headers: Record<string, string> }];
    expect(url).toBe("https://app.test/api/admin/status");
    expect(init.headers.Authorization).toBe("Bearer s3");
    expect(o.incidente).toHaveBeenCalledTimes(1);
    expect(o.incidente).toHaveBeenCalledWith("abrir-una-vez", TITULO, expect.stringContaining("2"));
    expect(TITULO).toBe("Prode: resultados en espera");
  });

  it("con cero cierra el incidente", async () => {
    const o = opciones(vi.fn(async () => status(0)));
    await avisarEspera(o);
    expect(o.incidente).toHaveBeenCalledWith("cerrar", TITULO, expect.any(String));
  });

  it("reintenta un error transitorio", async () => {
    const respuestas = [new Response("caído", { status: 503 }), status(0)];
    const o = opciones(vi.fn(async () => respuestas.shift()!));
    expect(await avisarEspera(o)).toBe(0);
    expect(o.esperar).toHaveBeenCalledTimes(1);
  });

  it("sin el dato no abre ni cierra nada: falla", async () => {
    for (const respuesta of [() => status(undefined), () => status("1"), () => new Response("x", { status: 500 }), () => new Response("no json")]) {
      const o = opciones(vi.fn(async () => respuesta()));
      await expect(avisarEspera(o)).rejects.toThrow();
      expect(o.incidente).not.toHaveBeenCalled();
    }
  });

  it("un 401 o un 429 no se reintentan", async () => {
    for (const codigo of [401, 429]) {
      const fetchImpl = vi.fn(async () => new Response("{}", { status: codigo }));
      await expect(avisarEspera(opciones(fetchImpl))).rejects.toThrow(String(codigo));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("el sync diario lo corre después de las ligas", () => {
    const workflow = readFileSync(".github/workflows/sync-cron.yml", "utf8").replace(/\r\n/g, "\n");
    const job = workflow.slice(workflow.indexOf("\n  prode-espera:"));
    expect(job).toContain("needs: [sync]");
    expect(job).toContain("node scripts/prode-espera.mjs");
    expect(job).toContain("ADMIN_SECRET: ${{ secrets.ADMIN_SECRET }}");
    expect(job).toContain("GH_TOKEN: ${{ github.token }}");
  });
});
