// scripts/sync-calendarios.mjs: encadena los lotes de la reconciliación de calendarios (docs/17).
// Mismo patrón que sync-por-lotes.sh para las ligas: un lote por request y `siguiente` marca si hay más.
import { describe, expect, it, vi } from "vitest";
import { sincronizarCalendarios } from "../../scripts/sync-calendarios.mjs";

const lote = (extra: Record<string, unknown> = {}) =>
  Response.json({ success: true, kind: "calendars", status: "success", corte: 1_800_000_000_000, siguiente: false, usuarios: 3, eventosOk: 4, eventosFallidos: 0, sinAcceso: 0, cortadoPorPresupuesto: false, quedan: false, subrequests: 30, ...extra });

const opciones = (fetchImpl: unknown, extra: Record<string, unknown> = {}) => ({
  appUrl: "https://app.test/",
  adminSecret: "s3",
  fetchImpl: fetchImpl as typeof fetch,
  esperar: vi.fn(async () => {}),
  log: vi.fn(),
  ...extra,
});

const cuerpo = (llamada: unknown[]) => JSON.parse((llamada[1] as { body: string }).body);

describe("sincronizarCalendarios", () => {
  it("un solo lote que cierra el barrido: pide con el secret y no manda corte", async () => {
    const fetchImpl = vi.fn(async () => lote());
    const r = await sincronizarCalendarios(opciones(fetchImpl));
    expect(r).toMatchObject({ completo: true, lotes: 1, usuarios: 3, eventosOk: 4, sinAcceso: 0 });
    expect(r.error).toBeUndefined();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe("https://app.test/api/admin/sync");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer s3");
    expect(cuerpo(fetchImpl.mock.calls[0])).toEqual({ calendarios: true });
  });

  it("encadena lotes con el corte del primero hasta que siguiente es false, con pausa entre lotes", async () => {
    const respuestas = [lote({ siguiente: true, corte: 111 }), lote({ siguiente: true, corte: 111, usuarios: 2 }), lote({ corte: 111, usuarios: 1 })];
    const fetchImpl = vi.fn(async () => respuestas.shift()!);
    const o = opciones(fetchImpl, { pausaMs: 7 });
    const r = await sincronizarCalendarios(o);
    expect(r).toMatchObject({ completo: true, lotes: 3, usuarios: 6 });
    expect(cuerpo(fetchImpl.mock.calls[0])).toEqual({ calendarios: true });
    expect(cuerpo(fetchImpl.mock.calls[1])).toEqual({ calendarios: true, corte: 111 });
    expect(cuerpo(fetchImpl.mock.calls[2])).toEqual({ calendarios: true, corte: 111 });
    expect(o.esperar).toHaveBeenCalledTimes(2);
    expect(o.esperar).toHaveBeenCalledWith(7);
  });

  it("al llegar al máximo de lotes con usuarios pendientes corta sin error: sigue en el próximo sync", async () => {
    const fetchImpl = vi.fn(async () => lote({ siguiente: true }));
    const r = await sincronizarCalendarios(opciones(fetchImpl, { maxLotes: 3 }));
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ completo: false, lotes: 3 });
    expect(r.error).toBeUndefined();
  });

  it("un lote sin progreso (ni un usuario atendido y con 'siguiente') es un error: no se repite sin fin", async () => {
    const fetchImpl = vi.fn(async () => lote({ siguiente: true, usuarios: 0, status: "partial", cortadoPorPresupuesto: true }));
    const r = await sincronizarCalendarios(opciones(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.error).toMatch(/sin progreso/);
  });

  it("un 401 corta al instante: el secret está mal cargado y se repetiría en todos", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ error: "Unauthorized" }, { status: 401 }));
    const r = await sincronizarCalendarios(opciones(fetchImpl));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.error).toMatch(/ADMIN_SECRET/);
  });

  it("reintenta un fallo transitorio y sigue", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("boom", { status: 503 }))
      .mockRejectedValueOnce(new Error("socket"))
      .mockResolvedValueOnce(lote());
    const o = opciones(fetchImpl, { reintentos: 2, pausaReintentoMs: 5 });
    const r = await sincronizarCalendarios(o);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ completo: true });
    expect(o.esperar).toHaveBeenCalledWith(5);
  });

  it("recursos excedidos (error 1102): espera más antes de reintentar", async () => {
    const fetchImpl = vi
      .fn<() => Promise<Response>>()
      .mockResolvedValueOnce(new Response("error code: 1102", { status: 503 }))
      .mockResolvedValueOnce(lote());
    const o = opciones(fetchImpl, { pausaTras1102Ms: 99 });
    expect((await sincronizarCalendarios(o)).completo).toBe(true);
    expect(o.esperar).toHaveBeenCalledWith(99);
  });

  it("si agota los reintentos devuelve el error con lo que se alcanzó a hacer", async () => {
    const respuestas = [lote({ siguiente: true, usuarios: 2 })];
    const fetchImpl = vi.fn(async () => respuestas.shift() ?? new Response("down", { status: 500 }));
    const r = await sincronizarCalendarios(opciones(fetchImpl, { reintentos: 1 }));
    expect(r.error).toMatch(/Lote 2 falló/);
    expect(r).toMatchObject({ lotes: 1, usuarios: 2, completo: false });
  });

  it("un lote con success false (500 del servidor) es un error y no se sigue", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ success: false, error: "D1 caída" }, { status: 500 }));
    const r = await sincronizarCalendarios(opciones(fetchImpl, { reintentos: 0 }));
    expect(r.error).toMatch(/D1 caída/);
  });
});
