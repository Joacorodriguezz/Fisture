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
  it("un 404 (ruta todavía no desplegada) avisa sin fallar y no cuenta como éxito", async () => {
    const o = opciones(con(new Response("Not found", { status: 404 })));
    expect(await correrPasada(o)).toEqual({ trabajo: "no_desplegado" });
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

  const paso = (nombre: string) => {
    const desde = workflow.indexOf(`- name: ${nombre}`);
    expect(desde).toBeGreaterThan(-1);
    const hasta = workflow.indexOf("- name:", desde + 7);
    return workflow.slice(desde, hasta === -1 ? undefined : hasta);
  };

  // Con `a && b || c`, un secret de staging vacío caería en el de producción
  it("cada entorno usa solo sus secretos, sin valores de respaldo", () => {
    expect(workflow).not.toMatch(/(ADMIN_SECRET|APP_URL):.*(&&|[|][|])/);
    const produccion = paso("Correr la pasada pendiente");
    expect(produccion).toContain("if: inputs.entorno != 'staging'");
    expect(produccion).toContain("ADMIN_SECRET: ${{ secrets.ADMIN_SECRET }}");
    expect(produccion).not.toContain("STAGING");
    const staging = paso("Correr la pasada en staging");
    expect(staging).toContain("if: inputs.entorno == 'staging'");
    expect(staging).toContain("ADMIN_SECRET: ${{ secrets.STAGING_ADMIN_SECRET }}");
    expect(staging).toContain("APP_URL: https://development.fisture.pages.dev");
    expect(staging).not.toContain("secrets.ADMIN_SECRET");
    expect(staging).not.toContain("PUBLIC_APP_URL");
  });

  it("abre su incidente sin repetir comentarios y no lo toca con un 404", () => {
    expect(workflow).toContain("node scripts/prode-sync.mjs");
    const abrir = paso("Avisar por issue si falló");
    expect(abrir).toContain("steps.pasada.outcome == 'failure' && steps.pasada.outputs.trabajo != 'false'");
    expect(abrir).toContain('incidente.sh abrir-una-vez "Falla el sync del prode"');
    const cerrar = paso("Cerrar el aviso si volvió a andar");
    expect(cerrar).toContain("steps.pasada.outcome == 'success' && steps.pasada.outputs.trabajo != 'no_desplegado'");
    expect(cerrar).toContain('incidente.sh cerrar "Falla el sync del prode"');
    const espera = paso("Abrir o cerrar el aviso de resultados en espera");
    expect(espera).toContain("steps.pasada.outputs.trabajo == 'true'");
    expect(espera).toContain("node scripts/prode-espera.mjs");
    for (const p of [abrir, cerrar, espera]) expect(p).toContain("inputs.entorno != 'staging'");
  });

  it("incidente.sh: abrir-una-vez no comenta un issue ya abierto; abrir sigue comentando", () => {
    const script = readFileSync(".github/scripts/incidente.sh", "utf8").replace(/\r\n/g, "\n");
    const caso = (accion: string) => script.slice(script.indexOf(`\n  ${accion})`), script.indexOf(";;", script.indexOf(`\n  ${accion})`)));
    expect(caso("abrir-una-vez")).toContain('if [ -z "$numero" ]');
    expect(caso("abrir-una-vez")).toContain("gh issue create");
    expect(caso("abrir-una-vez")).not.toContain("gh issue comment");
    expect(caso("abrir")).toContain("gh issue comment");
  });

  it("el keepalive lo reactiva si GitHub lo desactiva", () => {
    expect(WORKFLOWS_PROGRAMADOS).toContain("prode-sync.yml");
  });
});
