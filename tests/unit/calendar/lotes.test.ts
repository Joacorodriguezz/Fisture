import { describe, expect, it, vi } from "vitest";
import { partirEnLotes, sincronizarEnLotes } from "../../../src/lib/calendar/lotes";
import { MAX_PARTIDOS_POR_REQUEST } from "../../../src/lib/calendar/limites";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `m${i}`);
const respuesta = (lote: string[], falla = 0) =>
  new Response(JSON.stringify({ results: lote.map((matchId, i) => ({ matchId, success: i >= falla })) }), { status: falla ? 207 : 200 });

describe("partirEnLotes", () => {
  it("parte 20 ids en lotes de MAX_PARTIDOS_POR_REQUEST sin perder ni repetir", () => {
    const lotes = partirEnLotes(ids(20));
    expect(lotes.every((l) => l.length <= MAX_PARTIDOS_POR_REQUEST)).toBe(true);
    expect(lotes.flat()).toEqual(ids(20));
    expect(lotes).toHaveLength(Math.ceil(20 / MAX_PARTIDOS_POR_REQUEST));
  });
  it("una lista vacía no genera lotes y una corta genera uno", () => {
    expect(partirEnLotes([])).toEqual([]);
    expect(partirEnLotes(ids(2))).toEqual([ids(2)]);
  });
  it("25 partidos son 5 requests, dentro de calendar_sync (10 por minuto)", () => {
    expect(partirEnLotes(ids(25)).length).toBeLessThanOrEqual(10);
  });
});

describe("sincronizarEnLotes", () => {
  it("manda un lote por request en secuencia e informa el progreso", async () => {
    const enviar = vi.fn(async (l: string[]) => respuesta(l));
    const progreso: number[] = [];
    const r = await sincronizarEnLotes(ids(14), { enviar, tamano: 6, onProgreso: (h) => progreso.push(h) });
    expect(enviar.mock.calls.map((c) => c[0].length)).toEqual([6, 6, 2]);
    expect(progreso).toEqual([0, 6, 12]);
    expect(r).toMatchObject({ ok: 14, fallo: 0, limitado: false });
  });
  it("ante un 429 frena, no manda más lotes y conserva Retry-After", async () => {
    const enviar = vi
      .fn()
      .mockImplementationOnce(async (l: string[]) => respuesta(l))
      .mockImplementationOnce(async () => new Response("{}", { status: 429, headers: { "Retry-After": "42" } }));
    const r = await sincronizarEnLotes(ids(20), { enviar, tamano: 6 });
    expect(enviar).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({ ok: 6, limitado: true, retryAfter: "42" });
  });
  it("ante otros errores sigue con los demás lotes y cuenta los fallidos", async () => {
    const enviar = vi
      .fn()
      .mockImplementationOnce(async () => new Response("{}", { status: 500 }))
      .mockImplementationOnce(async () => {
        throw new Error("red");
      })
      .mockImplementationOnce(async (l: string[]) => respuesta(l, 1));
    const r = await sincronizarEnLotes(ids(14), { enviar, tamano: 6 });
    expect(enviar).toHaveBeenCalledTimes(3);
    expect(r).toMatchObject({ ok: 1, fallo: 13, limitado: false });
  });
  it("un 401 corta y pide login", async () => {
    const enviar = vi.fn(async () => new Response("{}", { status: 401 }));
    const r = await sincronizarEnLotes(ids(14), { enviar, tamano: 6 });
    expect(enviar).toHaveBeenCalledTimes(1);
    expect(r.sinSesion).toBe(true);
  });
});
