// Orden de las competencias destacadas al listarlas (docs/36 D1)
import { describe, expect, it } from "vitest";
import { LEAGUES_CONFIG } from "../../src/lib/data-providers";
import { nombreCorto, ordenarCompetencias } from "../../src/lib/competencias";

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

describe("nombreCorto", () => {
  it("acorta los nombres largos y deja el resto igual", () => {
    expect(nombreCorto("bol.1", "División Profesional de Bolivia")).toBe("Liga Boliviana");
    expect(nombreCorto("fifa.worldq.conmebol", "Eliminatorias Sudamericanas")).toBe("Eliminatorias");
    expect(nombreCorto("eng.1", "Premier League")).toBe("Premier League");
    expect(nombreCorto(null, "Otra")).toBe("Otra");
  });

  it("ningún nombre corto supera los 20 caracteres", () => {
    for (const id of ["arg.1", "bol.1", "chi.1", "par.1", "per.1", "uru.1", "uefa.champions", "uefa.europa", "uefa.europa.conf", "fifa.worldq.conmebol"]) {
      expect(nombreCorto(id, "x").length, id).toBeLessThanOrEqual(20);
    }
  });
});
