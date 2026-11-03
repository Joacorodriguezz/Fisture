// scripts/keepalive.mjs: mitigación de la desactivación de los workflows programados por GitHub
// (60 días sin actividad en el repo, docs/17 B1). Se prueba con un `gh` falso: sin red ni cuenta.
import { describe, expect, it, vi } from "vitest";
import { mantenerVivos } from "../../scripts/keepalive.mjs";

const HORA = 3_600_000;
const AHORA = Date.parse("2026-11-03T12:00:00Z");
const REPO = "dueño/fisture";

interface Escenario {
  estados?: Record<string, string>;
  ultimoSync?: string | null;
  falloEnable?: boolean;
}

function ghFalso({ estados = {}, ultimoSync = new Date(AHORA - 5 * HORA).toISOString(), falloEnable = false }: Escenario = {}) {
  const llamadas: string[][] = [];
  const gh = vi.fn(async (args: string[]) => {
    llamadas.push(args);
    const ruta = args.find((a) => a.startsWith("repos/")) ?? "";
    if (args.includes("PUT")) {
      if (falloEnable) throw new Error("HTTP 403");
      return "";
    }
    const runs = ruta.match(/actions\/workflows\/([^/]+)\/runs/);
    if (runs) return JSON.stringify({ workflow_runs: ultimoSync ? [{ updated_at: ultimoSync }] : [] });
    const archivo = ruta.split("/").pop()!;
    return JSON.stringify({ state: estados[archivo] ?? "active", path: `.github/workflows/${archivo}` });
  });
  return { gh, llamadas };
}

const correr = (e: Escenario = {}, extra: Record<string, unknown> = {}) => {
  const { gh, llamadas } = ghFalso(e);
  const log = vi.fn();
  return mantenerVivos({ repo: REPO, workflows: ["sync-cron.yml", "monitor.yml"], gh, ahora: () => AHORA, log, ...extra }).then((r) => ({ r, llamadas, log }));
};

const enables = (llamadas: string[][]) => llamadas.filter((a) => a.includes("PUT")).map((a) => a.find((x) => x.startsWith("repos/")));

describe("mantenerVivos", () => {
  it("todo activo y con un sync reciente: vuelve a habilitar igual (refresca el plazo) y no reporta nada", async () => {
    const { r, llamadas } = await correr();
    expect(r).toMatchObject({ reactivados: [], atrasado: false });
    expect(enables(llamadas)).toEqual([`repos/${REPO}/actions/workflows/sync-cron.yml/enable`, `repos/${REPO}/actions/workflows/monitor.yml/enable`]);
  });

  it("un workflow desactivado por inactividad se reactiva y se informa", async () => {
    const { r, log } = await correr({ estados: { "monitor.yml": "disabled_inactivity" } });
    expect(r.reactivados).toEqual(["monitor.yml"]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("monitor.yml"));
  });

  it("M1: un workflow desactivado a mano por el dueño no se reactiva ni se reporta como incidente", async () => {
    const { r, llamadas, log } = await correr({ estados: { "sync-cron.yml": "disabled_manually" } });
    expect(r.reactivados).toEqual([]);
    expect(enables(llamadas)).toEqual([`repos/${REPO}/actions/workflows/monitor.yml/enable`]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("disabled_manually"));
  });

  it("sin un sync exitoso en las últimas 72 h está atrasado", async () => {
    const viejo = new Date(AHORA - 73 * HORA).toISOString();
    const { r } = await correr({ ultimoSync: viejo });
    expect(r).toMatchObject({ atrasado: true, ultimoSyncExitoso: viejo });
  });

  it("justo dentro del plazo no está atrasado", async () => {
    expect((await correr({ ultimoSync: new Date(AHORA - 72 * HORA).toISOString() })).r.atrasado).toBe(false);
  });

  it("si nunca hubo un sync exitoso está atrasado", async () => {
    const { r } = await correr({ ultimoSync: null });
    expect(r).toMatchObject({ atrasado: true, ultimoSyncExitoso: null });
  });

  it("si no puede habilitar (permiso actions: write faltante) falla con un mensaje claro", async () => {
    await expect(correr({ falloEnable: true })).rejects.toThrow(/actions: write/);
  });

  it("no toca nada fuera del repo indicado", async () => {
    const { llamadas } = await correr();
    expect(llamadas.flat().filter((a) => a.startsWith("repos/")).every((a) => a.startsWith(`repos/${REPO}/`))).toBe(true);
  });
});
