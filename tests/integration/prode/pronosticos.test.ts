// Pronósticos, tabla e historial del prode (docs/37 §3.1 y §3.3).
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, DIA_MS, HORA_MS, relojFijo } from "../../helpers/clock";
import { LIGA, pronosticoDirecto, sembrarProde } from "../../helpers/prode";
import {
  crearGrupo,
  grupoParaMiembro,
  guardarPronosticos,
  historialDeGrupo,
  partidosParaPronosticar,
  pendientesDe,
  tablaDeGrupo,
  tablasDeGrupos,
  unirseAGrupo,
} from "../../../src/lib/prode/repo";

// Cuenta los viajes a D1 (prepare y batch) sin tocar el objeto real
function contarLlamadas(DB: D1Database) {
  const llamadas = { prepare: 0, batch: 0 };
  const espia = new Proxy(DB, {
    get(target, prop) {
      if (prop === "prepare" || prop === "batch") llamadas[prop]++;
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { DB: espia, llamadas };
}

describe("pronósticos", () => {
  const t = useTestDb();
  relojFijo();

  beforeEach(async () => {
    await sembrarProde(t.DB);
  });

  const leer = async (userId: string, matchId: string) =>
    t.DB.prepare("SELECT home_goals AS local, away_goals AS visitante, points FROM prode_predictions WHERE user_id = ?1 AND match_id = ?2").bind(userId, matchId).first();

  it("guarda, cambia y borra mientras el partido está abierto", async () => {
    let r = await guardarPronosticos(t.DB, "ana", [{ partidoId: "abierto-1", local: 2, visitante: 1 }], AHORA);
    expect(r).toEqual({ guardados: [{ partidoId: "abierto-1", local: 2, visitante: 1 }], borrados: [], rechazados: [] });
    expect(await leer("ana", "abierto-1")).toEqual({ local: 2, visitante: 1, points: null });

    r = await guardarPronosticos(t.DB, "ana", [{ partidoId: "abierto-1", local: 0, visitante: 0 }], AHORA);
    expect(r.guardados).toEqual([{ partidoId: "abierto-1", local: 0, visitante: 0 }]);
    expect(await leer("ana", "abierto-1")).toEqual({ local: 0, visitante: 0, points: null });

    r = await guardarPronosticos(t.DB, "ana", [{ partidoId: "abierto-1", local: null, visitante: null }], AHORA);
    expect(r).toEqual({ guardados: [], borrados: ["abierto-1"], rechazados: [] });
    expect(await leer("ana", "abierto-1")).toBeNull();
  });

  it("rechaza partidos cerrados, postergados, cancelados e inexistentes, y guarda el resto", async () => {
    const r = await guardarPronosticos(
      t.DB,
      "ana",
      [
        { partidoId: "abierto-2", local: 1, visitante: 3 },
        { partidoId: "empezado", local: 1, visitante: 0 },
        { partidoId: "en-juego", local: 1, visitante: 0 },
        { partidoId: "terminado-1", local: 2, visitante: 1 },
        { partidoId: "postergado", local: 1, visitante: 1 },
        { partidoId: "cancelado", local: 1, visitante: 1 },
        { partidoId: "no-existe", local: 1, visitante: 1 },
        { partidoId: "empezado", local: null, visitante: null },
      ],
      AHORA
    );
    expect(r.guardados).toEqual([{ partidoId: "abierto-2", local: 1, visitante: 3 }]);
    expect(r.rechazados).toEqual([
      { partidoId: "empezado", motivo: "cerrado" },
      { partidoId: "en-juego", motivo: "cerrado" },
      { partidoId: "terminado-1", motivo: "cerrado" },
      { partidoId: "postergado", motivo: "cerrado" },
      { partidoId: "cancelado", motivo: "cerrado" },
      { partidoId: "no-existe", motivo: "inexistente" },
    ]);
  });

  it("si se repite un partido, vale el último", async () => {
    const r = await guardarPronosticos(t.DB, "ana", [{ partidoId: "abierto-1", local: 1, visitante: 1 }, { partidoId: "abierto-1", local: 3, visitante: 2 }], AHORA);
    expect(r.guardados).toEqual([{ partidoId: "abierto-1", local: 3, visitante: 2 }]);
  });

  it("la guarda vive en el SQL: si el partido empieza entre la lectura y la escritura, no se guarda", async () => {
    // Reloj del servidor un segundo después del inicio, pero la lectura previa no lo sabe: se simula
    // con un `ahora` anterior y el partido movido justo antes de escribir
    const DB = t.DB;
    const espia = new Proxy(DB, {
      get(target, prop) {
        if (prop === "batch") {
          return async (stmts: unknown[]) => {
            await target.prepare("UPDATE matches SET status = 'live' WHERE id = 'abierto-1'").run();
            return target.batch(stmts as never);
          };
        }
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const r = await guardarPronosticos(espia, "ana", [{ partidoId: "abierto-1", local: 1, visitante: 0 }], AHORA);
    expect(r).toEqual({ guardados: [], borrados: [], rechazados: [{ partidoId: "abierto-1", motivo: "cerrado" }] });
    expect(await leer("ana", "abierto-1")).toBeNull();
  });

  it("cambiar un pronóstico ya puntuado (no debería pasar) borra los puntos", async () => {
    await pronosticoDirecto(t.DB, "ana", "abierto-1", 1, 1, 3);
    await guardarPronosticos(t.DB, "ana", [{ partidoId: "abierto-1", local: 2, visitante: 2 }], AHORA);
    expect(await leer("ana", "abierto-1")).toEqual({ local: 2, visitante: 2, points: null });
  });

  it("sin entradas no consulta la base", async () => {
    const { DB, llamadas } = contarLlamadas(t.DB);
    expect(await guardarPronosticos(DB, "ana", [], AHORA)).toEqual({ guardados: [], borrados: [], rechazados: [] });
    expect(llamadas).toEqual({ prepare: 0, batch: 0 });
  });

  it("partidos para pronosticar: abiertos de la liga en los próximos 30 días, con el pronóstico del usuario", async () => {
    await guardarPronosticos(t.DB, "ana", [{ partidoId: "abierto-2", local: 1, visitante: 0 }], AHORA);
    const lista = await partidosParaPronosticar(t.DB, "ana", LIGA, AHORA);
    expect(lista.map((p) => p.id)).toEqual(["abierto-1", "abierto-2"]);
    expect(lista[0]).toMatchObject({ id: "abierto-1", local: { id: "river", name: "River Plate", shortName: "RIV" }, visitante: { id: "boca" }, pronostico: null });
    expect(lista[1].pronostico).toEqual({ local: 1, visitante: 0 });
    expect(lista[0].dateTime.getTime()).toBe(Math.floor((AHORA.getTime() + 2 * HORA_MS) / 1000) * 1000);
  });

  it("pendientes: partidos abiertos de las ligas de tus grupos en 7 días sin pronóstico", async () => {
    await guardarPronosticos(t.DB, "ana", [{ partidoId: "abierto-2", local: 1, visitante: 0 }], AHORA);
    const pendientes = await pendientesDe(t.DB, "ana", [LIGA], AHORA);
    expect(pendientes.map((p) => [p.id, p.leagueId])).toEqual([["abierto-1", LIGA]]);
    expect(await pendientesDe(t.DB, "ana", [], AHORA)).toEqual([]);
  });
});

describe("tabla e historial", () => {
  const t = useTestDb();
  relojFijo();
  let grupoId: string;

  beforeEach(async () => {
    await sembrarProde(t.DB);
    // El grupo empieza hace 10 días: el partido "viejo" (hace 60) no cuenta
    const r = await crearGrupo(t.DB, { userId: "ana", nombre: "Los del Cinco", ligaId: LIGA, ahora: new Date(AHORA.getTime() - 10 * DIA_MS) });
    if (!r.ok) throw new Error(r.error);
    grupoId = r.id;
    for (const u of ["beto", "caro", "dani"]) await unirseAGrupo(t.DB, { userId: u, codigo: r.codigo, ahora: new Date(AHORA.getTime() - 9 * DIA_MS) });
    // terminado-1 fue 2-1, terminado-2 fue 0-0
    await pronosticoDirecto(t.DB, "ana", "terminado-1", 2, 1, 3);
    await pronosticoDirecto(t.DB, "ana", "terminado-2", 1, 0, 0);
    await pronosticoDirecto(t.DB, "beto", "terminado-1", 1, 0, 1);
    await pronosticoDirecto(t.DB, "beto", "terminado-2", 1, 1, 1);
    await pronosticoDirecto(t.DB, "caro", "terminado-1", 3, 1, 1);
    await pronosticoDirecto(t.DB, "caro", "terminado-2", 0, 0, 3);
    await pronosticoDirecto(t.DB, "caro", "viejo", 1, 0, 3);
    // Pronósticos de partidos abiertos: nunca se revelan
    await pronosticoDirecto(t.DB, "beto", "abierto-1", 7, 5);
    await pronosticoDirecto(t.DB, "beto", "postergado", 6, 6);
    // Alguien que no es del grupo
    await t.DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES ('ajeno', 'ajeno@example.test', 'Ajeno', 'google', 'ajeno')").run();
    await pronosticoDirecto(t.DB, "ajeno", "terminado-1", 2, 1, 3);
  });

  async function grupo() {
    const g = await grupoParaMiembro(t.DB, grupoId, "ana");
    if (!g) throw new Error("sin grupo");
    return g;
  }

  it("la tabla suma solo partidos de la liga desde el inicio del grupo, para los miembros", async () => {
    const filas = await tablaDeGrupo(t.DB, await grupo());
    const porUsuario = Object.fromEntries(filas.map((f) => [f.userId, [f.puntos, f.exactos, f.aciertos, f.jugados]]));
    expect(porUsuario).toEqual({
      ana: [3, 1, 1, 2],
      beto: [2, 0, 2, 2],
      caro: [4, 1, 2, 2],
      dani: [0, 0, 0, 0],
    });
    expect(filas.find((f) => f.userId === "dani")?.name).toBeNull();
  });

  it("tablas de varios grupos en un solo viaje a D1", async () => {
    const g = await grupo();
    const { DB, llamadas } = contarLlamadas(t.DB);
    const tablas = await tablasDeGrupos(DB, [g, g]);
    expect(llamadas.batch).toBe(1);
    expect(tablas.get(g.id)?.length).toBe(4);
    expect((await tablasDeGrupos(t.DB, [])).size).toBe(0);
  });

  it("historial: partidos empezados desde el inicio del grupo, del más reciente al más viejo", async () => {
    const h = await historialDeGrupo(t.DB, await grupo(), "ana", AHORA);
    expect(h.map((p) => [p.id, p.estado])).toEqual([
      ["empezado", "cerrado"],
      ["en-juego", "cerrado"],
      ["terminado-1", "cerrado"],
      ["cancelado", "cancelado"],
      ["terminado-2", "cerrado"],
      ["sin-marcador", "cerrado"],
    ]);
    const t1 = h.find((p) => p.id === "terminado-1")!;
    expect(t1.resultado).toEqual({ local: 2, visitante: 1 });
    expect(t1.mio).toEqual({ local: 2, visitante: 1, puntos: 3 });
    expect(t1.grupo.map((g) => [g.userId, g.nombre, g.local, g.visitante, g.puntos])).toEqual([
      ["ana", "Ana P.", 2, 1, 3],
      ["beto", "Beto P.", 1, 0, 1],
      ["caro", "Caro P.", 3, 1, 1],
    ]);
    expect(h.find((p) => p.id === "sin-marcador")?.resultado).toBeNull();
  });

  it("nunca revela pronósticos de partidos abiertos ni postergados", async () => {
    const h = await historialDeGrupo(t.DB, await grupo(), "beto", AHORA);
    expect(h.map((p) => p.id)).not.toContain("abierto-1");
    const todos = h.flatMap((p) => p.grupo);
    expect(todos.some((g) => g.local === 7 || g.local === 6)).toBe(false);
    // Con el partido postergado ya en el pasado tampoco se revela
    await t.DB.prepare("UPDATE matches SET date_time = ?1 WHERE id = 'postergado'").bind(Math.floor(AHORA.getTime() / 1000) - 60).run();
    const h2 = await historialDeGrupo(t.DB, await grupo(), "beto", AHORA);
    const post = h2.find((p) => p.id === "postergado");
    expect(post?.estado).toBe("postergado");
    expect(post?.grupo).toEqual([]);
    expect(post?.mio).toEqual({ local: 6, visitante: 6, puntos: null });
  });
});
