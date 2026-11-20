// Reglas puras del prode (docs/37 §3): puntaje, cierre, validaciones, códigos, nombres y tabla.
import { describe, expect, it } from "vitest";
import {
  ALFABETO_CODIGO,
  LARGO_CODIGO,
  MAX_PRONOSTICOS_POR_REQUEST,
  interpretarPronosticos,
  seRevela,
  PUNTOS_EXACTO,
  PUNTOS_TENDENCIA,
  estadoPartido,
  formatearCodigo,
  generarCodigo,
  nombreVisible,
  normalizarCodigo,
  normalizarNombreGrupo,
  ordenarTabla,
  puntosDe,
  validarGoles,
  type FilaTablaCruda,
} from "../../../src/lib/prode/reglas";

describe("puntosDe", () => {
  it.each([
    [{ local: 2, visitante: 1 }, { local: 2, visitante: 1 }, PUNTOS_EXACTO, "exacto"],
    [{ local: 0, visitante: 0 }, { local: 0, visitante: 0 }, PUNTOS_EXACTO, "empate exacto"],
    [{ local: 3, visitante: 0 }, { local: 1, visitante: 0 }, PUNTOS_TENDENCIA, "gana el local"],
    [{ local: 0, visitante: 2 }, { local: 1, visitante: 4 }, PUNTOS_TENDENCIA, "gana el visitante"],
    [{ local: 1, visitante: 1 }, { local: 2, visitante: 2 }, PUNTOS_TENDENCIA, "empate con otro marcador"],
    [{ local: 1, visitante: 1 }, { local: 2, visitante: 1 }, 0, "dijo empate y ganó el local"],
    [{ local: 2, visitante: 0 }, { local: 0, visitante: 2 }, 0, "invertido"],
  ])("%o contra %o → %i (%s)", (pronostico, resultado, puntos) => {
    expect(puntosDe(pronostico, resultado)).toBe(puntos);
  });

  it("el reglamento es 3 por exacto y 1 por ganador o empate", () => {
    expect([PUNTOS_EXACTO, PUNTOS_TENDENCIA]).toEqual([3, 1]);
  });
});

describe("estadoPartido", () => {
  const ahora = new Date("2026-11-20T15:00:00Z");
  const antes = new Date(ahora.getTime() - 60_000);
  const despues = new Date(ahora.getTime() + 60_000);

  it("programado y antes del inicio: abierto", () => {
    expect(estadoPartido({ status: "scheduled", dateTime: despues }, ahora)).toBe("abierto");
  });
  it("programado y ya pasó la hora: cerrado (aunque la fuente no lo marque en juego)", () => {
    expect(estadoPartido({ status: "scheduled", dateTime: antes }, ahora)).toBe("cerrado");
    expect(estadoPartido({ status: "scheduled", dateTime: ahora }, ahora)).toBe("cerrado");
  });
  it("en juego y terminado: cerrado", () => {
    expect(estadoPartido({ status: "live", dateTime: despues }, ahora)).toBe("cerrado");
    expect(estadoPartido({ status: "finished", dateTime: antes }, ahora)).toBe("cerrado");
  });
  it("postergado y cancelado tienen estado propio", () => {
    expect(estadoPartido({ status: "postponed", dateTime: despues }, ahora)).toBe("postergado");
    expect(estadoPartido({ status: "cancelled", dateTime: antes }, ahora)).toBe("cancelado");
  });
  it("sin estado se trata como programado", () => {
    expect(estadoPartido({ status: null, dateTime: despues }, ahora)).toBe("abierto");
  });
});

describe("validarGoles", () => {
  it.each([0, 1, 9, 20])("acepta %i", (n) => expect(validarGoles(n)).toBe(n));
  it.each([-1, 21, 1.5, "2", null, undefined, Number.NaN, Number.POSITIVE_INFINITY])("rechaza %p", (v) => {
    expect(validarGoles(v)).toBeNull();
  });
});

describe("códigos de invitación", () => {
  it("genera códigos del largo y el alfabeto esperados, sin caracteres ambiguos", () => {
    const codigos = new Set(Array.from({ length: 200 }, () => generarCodigo()));
    expect(codigos.size).toBeGreaterThan(195);
    for (const c of codigos) {
      expect(c).toHaveLength(LARGO_CODIGO);
      expect([...c].every((ch) => ALFABETO_CODIGO.includes(ch))).toBe(true);
    }
    expect(ALFABETO_CODIGO).not.toMatch(/[ILO01]/);
  });

  it("normaliza lo que escribe o pega la gente", () => {
    expect(normalizarCodigo("abcd efgh")).toBe("ABCDEFGH");
    expect(normalizarCodigo(" ABCD-EFGH ")).toBe("ABCDEFGH");
    expect(normalizarCodigo("abcdefgh")).toBe("ABCDEFGH");
  });

  it("rechaza largos distintos, caracteres ambiguos y tipos inválidos", () => {
    expect(normalizarCodigo("ABCDEFG")).toBeNull();
    expect(normalizarCodigo("ABCDEFGHJ")).toBeNull();
    expect(normalizarCodigo("ABCDEFG0")).toBeNull();
    expect(normalizarCodigo("ABCDEFGI")).toBeNull();
    expect(normalizarCodigo(12345678)).toBeNull();
    expect(normalizarCodigo(undefined)).toBeNull();
  });

  it("se muestra en dos bloques de cuatro", () => {
    expect(formatearCodigo("ABCDEFGH")).toBe("ABCD EFGH");
  });
});

describe("normalizarNombreGrupo", () => {
  it("recorta y colapsa espacios", () => {
    expect(normalizarNombreGrupo("  Los   del  Cinco ")).toBe("Los del Cinco");
  });
  it("quita caracteres de control", () => {
    expect(normalizarNombreGrupo("Ofi\u0000cina\n2026")).toBe("Oficina 2026");
  });
  it("exige entre 3 y 40 caracteres", () => {
    expect(normalizarNombreGrupo("ab")).toBeNull();
    expect(normalizarNombreGrupo("a".repeat(41))).toBeNull();
    expect(normalizarNombreGrupo("a".repeat(40))).toBe("a".repeat(40));
    expect(normalizarNombreGrupo(42)).toBeNull();
  });
});

describe("nombreVisible", () => {
  it("primer nombre e inicial del último", () => {
    expect(nombreVisible("Ana María Gómez")).toBe("Ana G.");
    expect(nombreVisible("  roberto díaz ")).toBe("Roberto D.");
  });
  it("un solo nombre queda igual", () => {
    expect(nombreVisible("Lucía")).toBe("Lucía");
  });
  it("sin nombre nunca muestra el email", () => {
    expect(nombreVisible(null)).toBe("Participante");
    expect(nombreVisible("   ")).toBe("Participante");
    expect(nombreVisible("ana@example.test")).toBe("Participante");
  });
});

describe("ordenarTabla", () => {
  const fila = (userId: string, puntos: number, exactos: number, aciertos: number, joinedAt: number): FilaTablaCruda => ({
    userId,
    name: userId.toUpperCase(),
    puntos,
    exactos,
    aciertos,
    jugados: aciertos + 1,
    joinedAt,
  });

  it("ordena por puntos, exactos y aciertos; empata la posición si todo coincide", () => {
    const tabla = ordenarTabla(
      [fila("c", 10, 2, 4, 3), fila("a", 12, 1, 9, 1), fila("b", 10, 3, 1, 2), fila("d", 10, 2, 4, 1), fila("e", 0, 0, 0, 0)],
      "d"
    );
    expect(tabla.map((f) => [f.userId, f.posicion])).toEqual([
      ["a", 1],
      ["b", 2],
      ["d", 3],
      ["c", 3],
      ["e", 5],
    ]);
    expect(tabla.find((f) => f.esVos)?.userId).toBe("d");
    expect(tabla[0].nombre).toBe("A");
  });

  it("una tabla vacía devuelve una lista vacía", () => {
    expect(ordenarTabla([], "x")).toEqual([]);
  });
});

describe("interpretarPronosticos", () => {
  it("separa guardar, borrar e inválidos; si se repite un partido vale el último", () => {
    expect(
      interpretarPronosticos({
        pronosticos: [
          { partidoId: "a", local: 1, visitante: 0 },
          { partidoId: "b", local: null, visitante: null },
          { partidoId: "c", local: 1 },
          { partidoId: "d", local: "2", visitante: 1 },
          { partidoId: "a", local: 2, visitante: 2 },
        ],
      })
    ).toEqual({
      ok: true,
      entradas: [
        { partidoId: "a", local: 2, visitante: 2 },
        { partidoId: "b", local: null, visitante: null },
      ],
      invalidos: ["c", "d"],
    });
  });

  it.each([undefined, null, {}, { pronosticos: {} }, { pronosticos: [{ partidoId: "" }] }, { pronosticos: [{ partidoId: "x".repeat(101) }] }, { pronosticos: [7] }])(
    "rechaza el cuerpo %p",
    (body) => expect(interpretarPronosticos(body)).toEqual({ ok: false, error: "cuerpo_invalido" })
  );

  it(`acepta hasta ${MAX_PRONOSTICOS_POR_REQUEST} pronósticos`, () => {
    const lista = (n: number) => ({ pronosticos: Array.from({ length: n }, (_, i) => ({ partidoId: `p${i}`, local: 0, visitante: 0 })) });
    expect(interpretarPronosticos(lista(MAX_PRONOSTICOS_POR_REQUEST)).ok).toBe(true);
    expect(interpretarPronosticos(lista(MAX_PRONOSTICOS_POR_REQUEST + 1))).toEqual({ ok: false, error: "demasiados_pronosticos" });
  });
});

describe("seRevela", () => {
  it("solo lo cerrado se muestra al grupo", () => {
    expect(["abierto", "cerrado", "postergado", "cancelado"].filter((e) => seRevela(e as never))).toEqual(["cerrado"]);
  });
});
