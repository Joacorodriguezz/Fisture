import { describe, expect, it } from "vitest";
import alargue from "../fixtures/espn-prode-alargue.json";
import fin90 from "../fixtures/espn-prode-fin-90.json";
import idaVuelta from "../fixtures/espn-prode-ida-vuelta.json";
import penales from "../fixtures/espn-prode-penales.json";
import sumAlargue from "../fixtures/espn-prode-summary-alargue.json";
import sumFin90 from "../fixtures/espn-prode-summary-fin-90.json";
import sumPenales from "../fixtures/espn-prode-summary-penales.json";
import {
  resultadoProde,
  type EventoEspnProde,
  type ResumenEspn,
} from "../../src/lib/data-providers/espn-resultado-prode";

/* eslint-disable @typescript-eslint/no-explicit-any */
// Los fixtures están recortados (team como nombre, status al tope); se llevan a la forma real de ESPN
function aEvento(fx: any): EventoEspnProde {
  return {
    status: fx.status,
    competitions: [
      {
        leg: fx.competicion?.leg,
        competitors: fx.competitors.map((c: any) => ({
          homeAway: c.homeAway,
          score: c.score,
          winner: c.winner,
          shootoutScore: c.shootoutScore,
          team: { id: c.team },
        })),
      },
    ],
  };
}
function aResumen(fx: any): ResumenEspn {
  return {
    header: {
      competitions: [
        {
          status: fx.header.status,
          competitors: fx.header.competitors.map((c: any) => ({
            homeAway: c.homeAway,
            score: c.score,
            winner: c.winner,
            shootoutScore: c.shootoutScore,
            linescores: c.linescores,
            team: { id: c.team },
          })),
        },
      ],
    },
  };
}
const ev = (lista: any[], id: string) => aEvento(lista.find((x) => x.id === id));
const res = (lista: any[], id: string) => aResumen(lista.find((x) => x.id === id));
const NULOS = { goles90: null, pasa: null };

function sint(
  estado: string,
  local: Record<string, unknown>,
  visitante: Record<string, unknown>,
  extra: { state?: string; leg?: unknown } = {},
): EventoEspnProde {
  return {
    status: { type: { name: estado, state: (extra.state ?? "post") as "post" } },
    competitions: [
      {
        leg: extra.leg as any,
        competitors: [
          { homeAway: "home", team: { id: "1" }, ...local },
          { homeAway: "away", team: { id: "2" }, ...visitante },
        ] as any,
      },
    ],
  };
}
function sintRes(estado: string, l: number[], v: number[], score: [string, string]): ResumenEspn {
  const ls = (a: number[]) => a.map((n) => ({ displayValue: String(n) }));
  return {
    header: {
      competitions: [
        {
          status: { type: { name: estado, state: "post" } },
          competitors: [
            { homeAway: "home", team: { id: "1" }, score: score[0], linescores: ls(l) },
            { homeAway: "away", team: { id: "2" }, score: score[1], linescores: ls(v) },
          ],
        },
      ],
    },
  };
}

describe("regla A: fin en los 90' (fixtures reales)", () => {
  it("todos los fin-90 reales: goles90 = score y pasa = lado con más goles", () => {
    for (const f of fin90) {
      const [h, a] = [f.competitors.find((c) => c.homeAway === "home")!, f.competitors.find((c) => c.homeAway === "away")!];
      const r = resultadoProde(aEvento(f));
      expect(r.goles90).toEqual({ local: Number(h.score), visitante: Number(a.score), regla: "A" });
      const g = Number(h.score) - Number(a.score);
      expect(r.pasa).toBe(g > 0 ? "home" : g < 0 ? "away" : null);
    }
  });

  it("con el summary de fin 90 sigue valiendo el score", () => {
    const r = resultadoProde(ev(fin90, "656227"), res(sumFin90, "656227"));
    expect(r.goles90?.regla).toBe("A");
  });

  it("sintético: empate en 90' da goles90 y pasa null", () => {
    const r = resultadoProde(sint("STATUS_FULL_TIME", { score: "1" }, { score: "1" }));
    expect(r).toEqual({ goles90: { local: 1, visitante: 1, regla: "A" }, pasa: null });
  });
});

describe("regla B: alargue (fixtures reales)", () => {
  it("Fluminense-Boca 2023: 1-1 a los 90' y pasa el que marca winner", () => {
    const f = alargue.find((x) => x.id === "688946")!;
    const r = resultadoProde(ev(alargue, "688946"), res(sumAlargue, "688946"));
    expect(r.goles90).toEqual({ local: 1, visitante: 1, regla: "B" });
    expect(r.pasa).toBe(f.competitors.find((c) => c.winner)!.homeAway);
  });

  it("Huracán-Boca 2026: 1-1 a los 90'", () => {
    const r = resultadoProde(ev(alargue, "401871437"), res(sumAlargue, "401871437"));
    expect(r.goles90).toEqual({ local: 1, visitante: 1, regla: "B" });
  });

  it("sin summary: goles90 null pero pasa se conserva", () => {
    const r = resultadoProde(ev(alargue, "688946"));
    expect(r.goles90).toBeNull();
    expect(r.pasa).not.toBeNull();
  });

  it("AGT (gol de oro) da null/null", () => {
    expect(resultadoProde(ev(alargue, "693401"), res(sumAlargue, "693401"))).toEqual(NULOS);
  });
});

describe("regla B: penales (fixtures reales)", () => {
  it("Boca-Lanús: 0-0 a los 90' y pasa Boca (tanda 4-2, local)", () => {
    const r = resultadoProde(ev(penales, "735663"), res(sumPenales, "735663"));
    expect(r.goles90).toEqual({ local: 0, visitante: 0, regla: "B" });
    expect(r.pasa).toBe("home");
  });

  it("todos los penales reales: pasa coincide con la mayor tanda", () => {
    for (const f of penales) {
      const [a, b] = f.competitors;
      const mayor = (a.shootoutScore ?? 0) > (b.shootoutScore ?? 0) ? a.homeAway : b.homeAway;
      expect(resultadoProde(aEvento(f)).pasa).toBe(mayor);
      const s = sumPenales.find((x) => x.id === f.id);
      if (s) {
        const r = resultadoProde(aEvento(f), aResumen(s));
        expect(r.pasa).toBe(mayor);
        if (r.goles90) expect(r.goles90.regla).toBe("B");
      }
    }
  });

  it("cruza el summary por homeAway aunque venga en otro orden", () => {
    const s = res(sumPenales, "735663");
    s.header!.competitions![0].competitors!.reverse();
    const r = resultadoProde(ev(penales, "735663"), s);
    expect(r.goles90).toEqual({ local: 0, visitante: 0, regla: "B" });
  });
});

describe("ida y vuelta y descartes", () => {
  it("un partido con leg da null/null aunque winner marque a alguien", () => {
    for (const f of idaVuelta) expect(resultadoProde(aEvento(f))).toEqual(NULOS);
  });

  it("sintético: estado fuera de la lista da null/null", () => {
    for (const n of ["STATUS_ABANDONED", "STATUS_CANCELED", "STATUS_FINAL", "STATUS_FINAL_AGT", "STATUS_X"]) {
      expect(resultadoProde(sint(n, { score: "1" }, { score: "0" }))).toEqual(NULOS);
    }
  });

  it("sintético: sin state post da null/null", () => {
    const e = sint("STATUS_FULL_TIME", { score: "1" }, { score: "0" }, { state: "in" });
    expect(resultadoProde(e)).toEqual(NULOS);
  });

  it("sintético: marcadores inválidos o fuera de 0-20", () => {
    for (const [a, b] of [["21", "0"], ["-1", "0"], ["1.5", "0"], ["x", "0"], ["", "0"]]) {
      expect(resultadoProde(sint("STATUS_FULL_TIME", { score: a }, { score: b }))).toEqual(NULOS);
    }
  });

  it("sintético: dos competidores del mismo lado da null/null", () => {
    const e = sint("STATUS_FULL_TIME", { score: "1" }, { score: "0", homeAway: "home" });
    expect(resultadoProde(e)).toEqual(NULOS);
  });
});

describe("regla B sintética", () => {
  const AET = "STATUS_FINAL_AET";
  const PEN = "STATUS_FINAL_PEN";

  it("sintético: dos winner true o ninguno da pasa null", () => {
    const rs = sintRes(AET, [1, 0, 1, 0], [1, 0, 0, 0], ["2", "1"]);
    const dos = sint(AET, { score: "2", winner: true }, { score: "1", winner: true });
    const ninguno = sint(AET, { score: "2", winner: false }, { score: "1", winner: false });
    expect(resultadoProde(dos, rs).pasa).toBeNull();
    expect(resultadoProde(ninguno, rs).pasa).toBeNull();
  });

  it("sintético: winner que contradice el marcador del alargue da pasa null (goles90 se conserva)", () => {
    const e = sint(AET, { score: "2", winner: false }, { score: "1", winner: true });
    expect(resultadoProde(e, sintRes(AET, [1, 0, 1, 0], [1, 0, 0, 0], ["2", "1"]))).toEqual({
      goles90: { local: 1, visitante: 1, regla: "B" },
      pasa: null,
    });
  });

  it("sintético: gol decisivo en el alargue", () => {
    const e = sint(AET, { score: "2", winner: true }, { score: "1", winner: false });
    const r = resultadoProde(e, sintRes(AET, [1, 0, 1, 0], [0, 1, 0, 0], ["2", "1"]));
    expect(r.goles90).toEqual({ local: 1, visitante: 1, regla: "B" });
    expect(r.pasa).toBe("home");
  });

  it("sintético: goles90 con ganador y pasa del otro lado anula ambos", () => {
    // A los 90' ganaba el local 2-0; final 2-3 con winner visitante
    const e = sint(AET, { score: "2", winner: false }, { score: "3", winner: true });
    const r = resultadoProde(e, sintRes(AET, [1, 1, 0, 0], [0, 0, 2, 1], ["2", "3"]));
    expect(r).toEqual(NULOS);
  });

  // Partido único: si hubo alargue o penales, a los 90' estaban empatados
  it("sintético: regla B con ganador a los 90' es un dato dudoso y da null/null", () => {
    const e = sint(AET, { score: "2", winner: true }, { score: "1", winner: false });
    expect(resultadoProde(e, sintRes(AET, [1, 1, 0, 0], [0, 0, 1, 0], ["2", "1"]))).toEqual(NULOS);
    const p = sint(PEN, { score: "1", winner: true, shootoutScore: 5 }, { score: "1", winner: false, shootoutScore: 3 });
    expect(resultadoProde(p, sintRes(PEN, [1, 0, 0, 0, 5], [0, 0, 1, 0, 3], ["1", "1"]))).toEqual(NULOS);
  });

  it("todos los alargue y penales reales con summary: empate a los 90'", () => {
    for (const [lista, resumenes] of [[alargue, sumAlargue], [penales, sumPenales]] as const) {
      for (const s of resumenes) {
        const r = resultadoProde(ev(lista, s.id), aResumen(s));
        if (r.goles90) expect(r.goles90.local).toBe(r.goles90.visitante);
      }
    }
  });

  it("sintético: parciales que no suman el score dan goles90 null y conservan pasa", () => {
    const e = sint(AET, { score: "2", winner: true }, { score: "1", winner: false });
    const r = resultadoProde(e, sintRes(AET, [1, 0, 0, 0], [1, 0, 0, 0], ["2", "1"]));
    expect(r.goles90).toBeNull();
    expect(r.pasa).toBe("home");
  });

  it("sintético: summary con otro score o estado no se usa", () => {
    const e = sint(AET, { score: "2", winner: true }, { score: "1", winner: false });
    expect(resultadoProde(e, sintRes(AET, [1, 0, 1, 0], [1, 0, 0, 0], ["3", "1"])).goles90).toBeNull();
    expect(resultadoProde(e, sintRes(PEN, [1, 0, 1, 0], [1, 0, 0, 0], ["2", "1"])).goles90).toBeNull();
  });

  it("sintético: linescores faltantes o incompletos dan goles90 null", () => {
    const e = sint(AET, { score: "2", winner: true }, { score: "1", winner: false });
    expect(resultadoProde(e, sintRes(AET, [1, 0, 1], [1, 0, 0], ["2", "1"])).goles90).toBeNull();
    expect(resultadoProde(e, { header: { competitions: [{ competitors: [] }] } }).goles90).toBeNull();
    expect(resultadoProde(e, {}).goles90).toBeNull();
  });

  it("sintético: penales con tanda que contradice winner da pasa null", () => {
    const e = sint(PEN, { score: "1", winner: true, shootoutScore: 3 }, { score: "1", winner: false, shootoutScore: 4 });
    expect(resultadoProde(e).pasa).toBeNull();
  });

  it("sintético: penales sin tanda o con tanda empatada da pasa null", () => {
    const sin = sint(PEN, { score: "1", winner: true }, { score: "1", winner: false });
    const igual = sint(PEN, { score: "1", winner: true, shootoutScore: 3 }, { score: "1", winner: false, shootoutScore: 3 });
    expect(resultadoProde(sin).pasa).toBeNull();
    expect(resultadoProde(igual).pasa).toBeNull();
  });

  it("sintético: penales con marcador no empatado da null/null", () => {
    const e = sint(PEN, { score: "2", winner: true, shootoutScore: 4 }, { score: "1", winner: false, shootoutScore: 3 });
    expect(resultadoProde(e)).toEqual(NULOS);
  });

  it("sintético: penales ignoran la 5ª entrada de linescores (tanda)", () => {
    const e = sint(PEN, { score: "1", winner: false, shootoutScore: 3 }, { score: "1", winner: true, shootoutScore: 5 });
    const r = resultadoProde(e, sintRes(PEN, [1, 0, 0, 0, 9], [0, 1, 0, 0, 9], ["1", "1"]));
    expect(r.goles90).toEqual({ local: 1, visitante: 1, regla: "B" });
    expect(r.pasa).toBe("away");
  });
});
