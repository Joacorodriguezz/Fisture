// Orden de las competencias destacadas al listarlas (docs/36 D1)
import { describe, expect, it } from "vitest";
import { LEAGUES_CONFIG } from "../../src/lib/data-providers";
import { ordenarCompetencias } from "../../src/lib/competencias";

const fila = (externalId: string) => ({ externalId, name: `Nombre ${externalId}` });

describe("prioridad de las competencias", () => {
  it("toda competencia destacada tiene una prioridad única y definida", () => {
    const prioridades = LEAGUES_CONFIG.filter((l) => l.destacada).map((l) => l.prioridad);
    expect(prioridades.every((p) => Number.isInteger(p))).toBe(true);
    expect(new Set(prioridades).size).toBe(prioridades.length);
  });

  it("las no destacadas van después de todas las destacadas", () => {
    const maxDestacada = Math.max(...LEAGUES_CONFIG.filter((l) => l.destacada).map((l) => l.prioridad));
    for (const l of LEAGUES_CONFIG.filter((c) => !c.destacada)) expect(l.prioridad).toBeGreaterThan(maxDestacada);
  });
});

describe("ordenarCompetencias", () => {
  it("respeta los 7 grupos en orden", () => {
    const desordenadas = [
      "fifa.worldq.conmebol", "ven.1", "bra.1", "uefa.europa.conf", "uefa.europa", "fra.1", "ger.1", "ita.1",
      "esp.1", "uefa.champions", "eng.1", "conmebol.sudamericana", "conmebol.libertadores", "arg.1",
    ].map(fila);
    const ids = ordenarCompetencias(desordenadas).map((c) => c.externalId);
    const grupos = [
      ["arg.1"],
      ["conmebol.libertadores", "conmebol.sudamericana"],
      ["eng.1", "uefa.champions"],
      ["esp.1", "ita.1", "ger.1", "fra.1"],
      ["uefa.europa", "uefa.europa.conf"],
      ["bra.1", "ven.1"],
      ["fifa.worldq.conmebol"],
    ];
    expect(ids).toEqual(grupos.flat());
  });

  it("las desconocidas van al final, desempatadas por nombre", () => {
    const res = ordenarCompetencias([
      { externalId: "zzz.9", name: "Zeta" },
      fila("eng.1"),
      { externalId: "aaa.9", name: "Alfa" },
      fila("arg.1"),
    ]);
    expect(res.map((c) => c.externalId)).toEqual(["arg.1", "eng.1", "aaa.9", "zzz.9"]);
  });

  it("desempata por nombre y no muta la entrada", () => {
    const entrada = [
      { externalId: "x.2", name: "Beta" },
      { externalId: "x.1", name: "Alfa" },
    ];
    const copia = [...entrada];
    expect(ordenarCompetencias(entrada).map((c) => c.name)).toEqual(["Alfa", "Beta"]);
    expect(entrada).toEqual(copia);
  });

  it("conserva los demás campos de cada fila", () => {
    const res = ordenarCompetencias([{ externalId: "arg.1", name: "A", id: "l1" }]);
    expect(res[0].id).toBe("l1");
  });
});
