// POST/PATCH /api/admin/prode/partidos: carga manual de los cruces de playoffs y corrección de horario/fase.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { relojFijo } from "../../helpers/clock";
import { d1ConCambioAntesDelBatch } from "../../helpers/d1-intercalado";
import { GET, PATCH, POST } from "../../../src/pages/api/admin/prode/partidos";

const ADMIN = "admin-de-prueba";
// Después del inicio del cruce de prueba (22/11 21:00 ART = 23/11 00:00 UTC): ya se le puede cargar el resultado
const DESPUES = new Date("2026-11-23T02:00:00Z");

describe("/api/admin/prode/partidos", () => {
  const t = useTestDb();
  // Hora del servidor fija antes de los cruces de prueba (22/11): los PATCH no dependen del día en que corre la suite
  relojFijo(new Date("2026-11-20T15:00:00Z"));

  beforeEach(async () => {
    silenciarConsola(vi);
    await t.DB.batch([
      t.DB.prepare("INSERT INTO leagues (id, external_id, name, country, season) VALUES ('lpf', 'espn:arg.1', 'Liga Profesional', 'Argentina', 2026)"),
      t.DB.prepare("INSERT INTO teams (id, external_id, name, league_id) VALUES ('boca', 'espn:5', 'Boca Juniors', 'lpf')"),
      t.DB.prepare("INSERT INTO teams (id, external_id, name, league_id) VALUES ('edlp', 'espn:6', 'Estudiantes', 'lpf')"),
    ]);
  });

  const llamar = async (method: "POST" | "PATCH", body: unknown, auth: string | null = `Bearer ${ADMIN}`) => {
    const handler = method === "POST" ? POST : PATCH;
    const res = await handler(
      apiCtx({
        url: "https://fisture.test/api/admin/prode/partidos",
        method,
        body,
        headers: auth === null ? {} : { Authorization: auth },
        env: { ENVIRONMENT: "test", DB: t.DB, KV: kvEnMemoria(), ADMIN_SECRET: ADMIN },
      })
    );
    return { status: res.status, body: (await res.json()) as any };
  };

  const cruce = { leagueId: "lpf", homeTeamId: "boca", awayTeamId: "edlp", fase: "cuartos", horario: "2026-11-22T21:00" };
  const fila = (id: string) => t.DB.prepare("SELECT * FROM matches WHERE id = ?").bind(id).first<any>();

  it("sin Bearer válido responde 401 y no escribe", async () => {
    for (const auth of [null, "Bearer otro"]) expect((await llamar("POST", cruce, auth)).status).toBe(401);
    expect((await llamar("PATCH", { id: "x", horario: "2026-11-22T21:00" }, null)).status).toBe(401);
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM matches").first<any>()).n).toBe(0);
  });

  it("POST agrega un cruce con equipos, fase y horario argentino", async () => {
    const res = await llamar("POST", cruce);
    expect(res.status).toBe(201);
    expect(res.body.partido).toMatchObject({
      fase: "cuartos",
      faseEtiqueta: "Cuartos de final",
      horario: { fecha: "Dom 22/11", hora: "21:00", iso: "2026-11-22T21:00-03:00" },
      local: { id: "boca", nombre: "Boca Juniors" },
      visitante: { id: "edlp", nombre: "Estudiantes" },
    });
    const guardado = await fila(res.body.partido.id);
    // El instante guardado es el que cierra el pronóstico: 21:00 ART = 00:00 UTC del día siguiente
    expect(guardado).toMatchObject({ date_time: Date.parse("2026-11-23T00:00:00Z") / 1000, round: "cuartos", source: "manual", status: "scheduled", league_id: "lpf" });
    expect(guardado.external_id).toMatch(/^prode:/);
  });

  it("POST valida los datos antes de escribir", async () => {
    const malos = [
      { ...cruce, fase: "grupos" },
      { ...cruce, horario: "2026-11-22T21:00:00Z" },
      { ...cruce, awayTeamId: "boca" },
      { ...cruce, homeTeamId: undefined },
    ];
    for (const body of malos) expect((await llamar("POST", body)).status).toBe(400);
    expect((await llamar("POST", { ...cruce, awayTeamId: "no-existe" })).status).toBe(404);
    expect((await llamar("POST", { ...cruce, leagueId: "no-existe" })).status).toBe(404);
    expect((await llamar("POST", "no es json{")).status).toBe(400);
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM matches").first<any>()).n).toBe(0);
  });

  it("PATCH corrige un horario reprogramado y la fase", async () => {
    const { body } = await llamar("POST", cruce);
    const res = await llamar("PATCH", { id: body.partido.id, horario: "2026-11-23T19:15", fase: "semifinal" });
    expect(res.status).toBe(200);
    expect(res.body.partido).toMatchObject({ fase: "semifinal", horario: { iso: "2026-11-23T19:15-03:00", hora: "19:15" } });
    expect(await fila(body.partido.id)).toMatchObject({ date_time: Date.parse("2026-11-23T22:15:00Z") / 1000, round: "semifinal" });
  });

  it("PATCH rechaza cambiar horario o fase de un partido que ya empezó", async () => {
    const { body } = await llamar("POST", cruce);
    const id = body.partido.id;
    const original = await fila(id);
    const intentar = async () => {
      for (const cambio of [{ horario: "2026-11-25T21:00" }, { fase: "semifinal" }]) {
        const res = await llamar("PATCH", { id, ...cambio });
        expect(res.status).toBe(409);
        expect(res.body.error).toBe("partido_ya_empezado");
      }
      expect(await fila(id)).toMatchObject({ date_time: original.date_time, round: "cuartos" });
    };

    // Horario ya alcanzado (hora del servidor), aunque el estado siga programado
    vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    await intentar();

    // Horario futuro pero en vivo o terminado
    vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
    for (const status of ["live", "finished", "cancelled"]) {
      await t.DB.prepare("UPDATE matches SET status = ? WHERE id = ?").bind(status, id).run();
      await intentar();
    }

    // Suspendido después de empezar: queda postponed con el horario ya pasado
    vi.setSystemTime(new Date("2026-11-23T00:30:00Z"));
    await t.DB.prepare("UPDATE matches SET status = 'postponed' WHERE id = ?").bind(id).run();
    await intentar();
  });

  it("PATCH permite reprogramar un partido postergado antes de empezar", async () => {
    const { body } = await llamar("POST", cruce);
    await t.DB.prepare("UPDATE matches SET status = 'postponed' WHERE id = ?").bind(body.partido.id).run();
    const res = await llamar("PATCH", { id: body.partido.id, horario: "2026-11-29T19:00" });
    expect(res.status).toBe(200);
    expect(res.body.partido.horario.iso).toBe("2026-11-29T19:00-03:00");
  });

  it("PATCH rechaza el resultado de un partido que todavía no empezó", async () => {
    const { body } = await llamar("POST", cruce);
    const res = await llamar("PATCH", { id: body.partido.id, status: "finished", homeScore: 2, awayScore: 1 });
    expect(res).toMatchObject({ status: 409, body: { error: "partido_no_empezado" } });
    expect(await fila(body.partido.id)).toMatchObject({ status: "scheduled", home_score: null, away_score: null });
    // Desde el instante del inicio sí se acepta
    vi.setSystemTime(new Date("2026-11-23T00:00:00Z"));
    expect((await llamar("PATCH", { id: body.partido.id, status: "finished", homeScore: 2, awayScore: 1 })).status).toBe(200);
  });

  it("PATCH carga el resultado de un partido terminado", async () => {
    const { body } = await llamar("POST", cruce);
    vi.setSystemTime(DESPUES);
    const res = await llamar("PATCH", { id: body.partido.id, status: "finished", homeScore: 2, awayScore: 1 });
    expect(res.status).toBe(200);
    expect(res.body.partido).toMatchObject({ estado: "finished", resultado: { local: 2, visitante: 1 } });
    expect(await fila(body.partido.id)).toMatchObject({ status: "finished", home_score: 2, away_score: 1, round: "cuartos" });
  });

  it("PATCH valida estado y marcador antes de escribir", async () => {
    const { body } = await llamar("POST", cruce);
    const id = body.partido.id;
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ status: "finished" }, "faltan_goles"],
      [{ status: "finished", homeScore: 1 }, "faltan_goles"],
      [{ homeScore: 1, awayScore: 0 }, "resultado_sin_finalizar"],
      [{ status: "live", homeScore: 1, awayScore: 0 }, "resultado_sin_finalizar"],
      [{ status: "finished", homeScore: 21, awayScore: 0 }, "marcador_invalido"],
      [{ status: "finished", homeScore: -1, awayScore: 0 }, "marcador_invalido"],
      [{ status: "finished", homeScore: 1.5, awayScore: 0 }, "marcador_invalido"],
      [{ status: "finished", homeScore: "2", awayScore: 0 }, "marcador_invalido"],
      [{ status: "terminado" }, "estado_invalido"],
    ];
    for (const [cambio, codigo] of casos) {
      const res = await llamar("PATCH", { id, ...cambio });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(codigo);
    }
    expect(await fila(id)).toMatchObject({ status: "scheduled", home_score: null, away_score: null });
    // Los límites del rango valen
    vi.setSystemTime(DESPUES);
    expect((await llamar("PATCH", { id, status: "finished", homeScore: 0, awayScore: 20 })).status).toBe(200);
  });

  it("PATCH corrige un resultado ya cargado y es idempotente", async () => {
    const { body } = await llamar("POST", cruce);
    const id = body.partido.id;
    vi.setSystemTime(DESPUES);
    await llamar("PATCH", { id, status: "finished", homeScore: 2, awayScore: 1 });
    const corregido = { id, status: "finished", homeScore: 1, awayScore: 1 };
    for (let i = 0; i < 2; i++) {
      const res = await llamar("PATCH", corregido);
      expect(res.status).toBe(200);
      expect(res.body.partido.resultado).toEqual({ local: 1, visitante: 1 });
    }
    expect(await fila(id)).toMatchObject({ status: "finished", home_score: 1, away_score: 1 });
  });

  it("PATCH a cancelado, postergado o programado limpia los goles", async () => {
    const { body } = await llamar("POST", cruce);
    const id = body.partido.id;
    vi.setSystemTime(DESPUES);
    for (const status of ["cancelled", "postponed", "scheduled"]) {
      await llamar("PATCH", { id, status: "finished", homeScore: 3, awayScore: 0 });
      const res = await llamar("PATCH", { id, status });
      expect(res.status).toBe(200);
      expect(res.body.partido).toMatchObject({ estado: status, resultado: null });
      expect(await fila(id)).toMatchObject({ status, home_score: null, away_score: null });
    }
  });

  it("PATCH acepta el resultado de un partido ya empezado pero sigue rechazando cambiarle el horario", async () => {
    const { body } = await llamar("POST", cruce);
    const id = body.partido.id;
    vi.setSystemTime(new Date("2026-11-23T02:00:00Z"));
    expect((await llamar("PATCH", { id, status: "live" })).status).toBe(200);
    const res = await llamar("PATCH", { id, status: "finished", homeScore: 0, awayScore: 0 });
    expect(res.status).toBe(200);
    expect(res.body.partido.resultado).toEqual({ local: 0, visitante: 0 });

    for (const cambio of [{ horario: "2026-11-25T21:00" }, { fase: "semifinal" }, { status: "finished", homeScore: 1, awayScore: 0, horario: "2026-11-25T21:00" }]) {
      const rechazo = await llamar("PATCH", { id, ...cambio });
      expect(rechazo.status).toBe(409);
      expect(rechazo.body.error).toBe("partido_ya_empezado");
    }
    expect(await fila(id)).toMatchObject({ status: "finished", home_score: 0, away_score: 0, round: "cuartos", date_time: Date.parse("2026-11-23T00:00:00Z") / 1000 });
  });

  // Carrera con el sync: entre la lectura del PATCH y su batch el partido pasa a live. El PATCH, con su
  // lectura vieja, no puede dejar el pronóstico abierto: 409 partido_cambio, fila sin tocar y cerrado.
  it("PATCH con el partido cambiado entre la lectura y la escritura responde 409 y no lo reabre", async () => {
    for (const cambio of [{ horario: "2026-11-23T19:15", fase: "semifinal" }, { status: "scheduled" }]) {
      const { body } = await llamar("POST", cruce);
      const id = body.partido.id;
      const DB = d1ConCambioAntesDelBatch(t.DB, /update\s+"matches"/i, () =>
        t.DB.prepare("UPDATE matches SET status = 'live' WHERE id = ?").bind(id).run()
      );
      const res = await PATCH(
        apiCtx({
          url: "https://fisture.test/api/admin/prode/partidos",
          method: "PATCH",
          body: { id, ...cambio },
          headers: { Authorization: `Bearer ${ADMIN}` },
          env: { ENVIRONMENT: "test", DB, KV: kvEnMemoria(), ADMIN_SECRET: ADMIN },
        })
      );
      expect(res.status).toBe(409);
      expect(((await res.json()) as any).error).toBe("partido_cambio");
      expect(await fila(id)).toMatchObject({ status: "live", round: "cuartos", date_time: Date.parse("2026-11-23T00:00:00Z") / 1000 });
      const vinculo = await t.DB.prepare("SELECT fase, closed_at FROM prode_matches WHERE match_id = ?").bind(id).first<any>();
      expect(vinculo).toMatchObject({ fase: "cuartos", closed_at: expect.any(Number) });
      await t.DB.prepare("DELETE FROM prode_matches").run();
      await t.DB.prepare("DELETE FROM matches").run();
    }
  });

  it("PATCH no carga resultados en partidos que trae el sync", async () => {
    await t.DB.prepare("INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, source) VALUES ('espn-1', 'espn:1', 'boca', 'edlp', 'lpf', 1795000000, 'espn')").run();
    const res = await llamar("PATCH", { id: "espn-1", status: "finished", homeScore: 2, awayScore: 0 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("partido_no_manual");
    expect(await fila("espn-1")).toMatchObject({ status: "scheduled", home_score: null, away_score: null });
  });

  it("GET lista solo los cruces manuales, ordenados por horario", async () => {
    const tarde = await llamar("POST", { ...cruce, horario: "2026-11-23T21:00", fase: "semifinal" });
    const temprano = await llamar("POST", cruce);
    await t.DB.prepare("INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, source) VALUES ('espn-1', 'espn:1', 'boca', 'edlp', 'lpf', 1700000000, 'espn')").run();
    const ctx = (auth: Record<string, string>) =>
      apiCtx({ url: "https://fisture.test/api/admin/prode/partidos", headers: auth, env: { ENVIRONMENT: "test", DB: t.DB, KV: kvEnMemoria(), ADMIN_SECRET: ADMIN } });
    expect((await GET(ctx({}))).status).toBe(401);
    const res = await GET(ctx({ Authorization: `Bearer ${ADMIN}` }));
    const { partidos } = (await res.json()) as any;
    expect(partidos.map((p: any) => p.id)).toEqual([temprano.body.partido.id, tarde.body.partido.id]);
    expect(partidos[1]).toMatchObject({ fase: "semifinal", horario: { hora: "21:00", fecha: "Lun 23/11" } });
  });

  it("PATCH rechaza cambios vacíos, partidos inexistentes y partidos que trae el sync", async () => {
    const { body } = await llamar("POST", cruce);
    expect((await llamar("PATCH", { id: body.partido.id })).status).toBe(400);
    expect((await llamar("PATCH", { id: body.partido.id, horario: "mañana" })).status).toBe(400);
    expect((await llamar("PATCH", { id: body.partido.id, fase: "grupos" })).status).toBe(400);
    expect((await llamar("PATCH", { id: "no-existe", fase: "final" })).status).toBe(404);

    await t.DB.prepare("INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, source) VALUES ('espn-1', 'espn:1', 'boca', 'edlp', 'lpf', 1795000000, 'espn')").run();
    const ajeno = await llamar("PATCH", { id: "espn-1", fase: "final" });
    expect(ajeno.status).toBe(409);
    expect(ajeno.body.error).toBe("partido_no_manual");
    expect(await fila("espn-1")).toMatchObject({ round: null, date_time: 1795000000 });
  });

  describe("vínculo prode_matches y adopción de partidos de ESPN", () => {
    const vinculo = (id: string) => t.DB.prepare("SELECT * FROM prode_matches WHERE match_id = ?").bind(id).first<any>();
    const espn = () =>
      t.DB.prepare("INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, source, round) VALUES ('espn-1', 'espn:1', 'boca', 'edlp', 'lpf', ?, 'espn', 'Quarterfinals')")
        .bind(Date.parse("2026-11-23T00:30:00Z") / 1000)
        .run();

    it("POST de un cruce manual crea su vínculo con la fase", async () => {
      const { body } = await llamar("POST", cruce);
      expect(await vinculo(body.partido.id)).toMatchObject({ fase: "cuartos" });
    });

    it("PATCH de fase actualiza también el vínculo", async () => {
      const { body } = await llamar("POST", cruce);
      expect((await llamar("PATCH", { id: body.partido.id, fase: "semifinal" })).status).toBe(200);
      expect(await vinculo(body.partido.id)).toMatchObject({ fase: "semifinal" });
    });

    it("PATCH de un partido empezado fija el cierre definitivo; antes de empezar no", async () => {
      const { body } = await llamar("POST", cruce);
      await llamar("PATCH", { id: body.partido.id, fase: "semifinal" });
      expect(await vinculo(body.partido.id)).toMatchObject({ closed_at: null });
      vi.setSystemTime(DESPUES);
      await llamar("PATCH", { id: body.partido.id, status: "postponed" });
      expect(await vinculo(body.partido.id)).toMatchObject({ closed_at: DESPUES.getTime() });
    });

    it("POST {adoptar, fase} suma un partido de ESPN al prode sin tocarlo", async () => {
      await espn();
      const antes = await fila("espn-1");
      const res = await llamar("POST", { adoptar: "espn-1", fase: "cuartos" });
      expect(res.status).toBe(201);
      expect(res.body.partido).toMatchObject({ id: "espn-1", fase: "cuartos", local: { id: "boca" }, visitante: { id: "edlp" } });
      expect(await vinculo("espn-1")).toMatchObject({ fase: "cuartos" });
      expect(await fila("espn-1")).toEqual(antes);
    });

    it("POST {adoptar} valida fase, existencia y que no esté ya en el prode", async () => {
      await espn();
      expect((await llamar("POST", { adoptar: "espn-1", fase: "grupos" })).status).toBe(400);
      expect((await llamar("POST", { adoptar: "", fase: "cuartos" })).status).toBe(400);
      const inexistente = await llamar("POST", { adoptar: "no-existe", fase: "cuartos" });
      expect(inexistente).toMatchObject({ status: 404, body: { error: "partido_inexistente" } });
      await llamar("POST", { adoptar: "espn-1", fase: "cuartos" });
      const repetido = await llamar("POST", { adoptar: "espn-1", fase: "final" });
      expect(repetido).toMatchObject({ status: 409, body: { error: "ya_en_prode" } });
      expect(await vinculo("espn-1")).toMatchObject({ fase: "cuartos" });
    });

    it("un partido adoptado figura en el GET pero no se edita a mano", async () => {
      await espn();
      await llamar("POST", { adoptar: "espn-1", fase: "cuartos" });
      const res = await GET(apiCtx({ url: "https://fisture.test/api/admin/prode/partidos", headers: { Authorization: `Bearer ${ADMIN}` }, env: { ENVIRONMENT: "test", DB: t.DB, KV: kvEnMemoria(), ADMIN_SECRET: ADMIN } }));
      expect(((await res.json()) as any).partidos.map((p: any) => p.id)).toEqual(["espn-1"]);
      for (const cambio of [{ horario: "2026-11-25T21:00" }, { status: "finished", homeScore: 1, awayScore: 0 }, { fase: "final" }]) {
        expect(await llamar("PATCH", { id: "espn-1", ...cambio })).toMatchObject({ status: 409, body: { error: "partido_no_manual" } });
      }
    });

    // La pierna es lo último que el adaptador suma a la ronda: un torneo con "Vuelta" en el nombre no es una vuelta
    it("POST {adoptar} solo rechaza la pierna al final de la ronda, no un nombre que contiene Vuelta", async () => {
      await espn();
      await t.DB.prepare("UPDATE matches SET round = 'Segunda Vuelta Final' WHERE id = 'espn-1'").run();
      expect((await llamar("POST", { adoptar: "espn-1", fase: "cuartos" })).status).toBe(201);
      await t.DB.prepare("DELETE FROM prode_matches WHERE match_id = 'espn-1'").run();
      for (const ronda of ["Segunda Vuelta Ida", "Segunda Vuelta Vuelta", "Final Ida"]) {
        await t.DB.prepare("UPDATE matches SET round = ? WHERE id = 'espn-1'").bind(ronda).run();
        expect(await llamar("POST", { adoptar: "espn-1", fase: "cuartos" })).toMatchObject({ status: 409, body: { error: "partido_con_vuelta" } });
      }
    });

    // docs/40 R6: "quién pasa" se define por partido único; un partido de ida o vuelta no se adopta
    it("POST {adoptar} rechaza con 409 partido_con_vuelta un partido de ida o de vuelta", async () => {
      await espn();
      for (const ronda of ["Quarterfinals · Ida", "Quarterfinals · Vuelta", "Vuelta"]) {
        await t.DB.prepare("UPDATE matches SET round = ? WHERE id = 'espn-1'").bind(ronda).run();
        expect(await llamar("POST", { adoptar: "espn-1", fase: "cuartos" })).toMatchObject({ status: 409, body: { error: "partido_con_vuelta" } });
      }
      expect(await vinculo("espn-1")).toBeNull();
      await t.DB.prepare("UPDATE matches SET round = 'Quarterfinals' WHERE id = 'espn-1'").run();
      expect((await llamar("POST", { adoptar: "espn-1", fase: "cuartos" })).status).toBe(201);
    });

    // docs/40 R3 y D2: quién pasó, solo cuando el marcador a 90' es empate (con ganador se deriva)
    describe("PATCH {id, pasa}: equipo que pasó", () => {
      const adoptado = async () => {
        await espn();
        await llamar("POST", { adoptar: "espn-1", fase: "cuartos" });
        await t.DB.prepare("UPDATE matches SET status = 'finished', home_score = 3, away_score = 2 WHERE id = 'espn-1'").run();
        vi.setSystemTime(DESPUES);
      };
      const manualEmpatado = async () => {
        const { body } = await llamar("POST", cruce);
        vi.setSystemTime(DESPUES);
        await llamar("PATCH", { id: body.partido.id, status: "finished", homeScore: 1, awayScore: 1 });
        return body.partido.id as string;
      };

      it("un adoptado: fija marcador a 90' y pasa juntos, y los muestra", async () => {
        await adoptado();
        const res = await llamar("PATCH", { id: "espn-1", homeGoals90: 2, awayGoals90: 2, pasa: "away" });
        expect(res.status).toBe(200);
        expect(res.body.partido).toMatchObject({ resultado: { local: 2, visitante: 2 }, pasa: "away" });
        expect(await vinculo("espn-1")).toMatchObject({ home_goals_90: 2, away_goals_90: 2, pasa: "away" });
      });

      it("un adoptado: pasa solo, sobre un marcador empatado ya confirmado", async () => {
        await adoptado();
        await llamar("PATCH", { id: "espn-1", homeGoals90: 0, awayGoals90: 0 });
        expect((await llamar("PATCH", { id: "espn-1", pasa: "home" })).body.partido).toMatchObject({ pasa: "home" });
        expect((await llamar("PATCH", { id: "espn-1", pasa: null })).body.partido).toMatchObject({ pasa: null });
        expect(await vinculo("espn-1")).toMatchObject({ pasa: null });
      });

      it("un cruce manual empatado: pasa solo", async () => {
        const id = await manualEmpatado();
        const res = await llamar("PATCH", { id, pasa: "away" });
        expect(res.status).toBe(200);
        expect(res.body.partido).toMatchObject({ resultado: { local: 1, visitante: 1 }, pasa: "away" });
        expect(await vinculo(id)).toMatchObject({ pasa: "away" });
      });

      it("un cruce manual: un pasa viejo no sobrevive a un ganador ni a retirar el resultado", async () => {
        const id = await manualEmpatado();
        await llamar("PATCH", { id, pasa: "away" });
        await llamar("PATCH", { id, status: "finished", homeScore: 2, awayScore: 0 });
        expect(await vinculo(id)).toMatchObject({ pasa: null });
        const vuelve = await llamar("PATCH", { id, status: "finished", homeScore: 1, awayScore: 1 });
        expect(vuelve.body.partido).toMatchObject({ pasa: null });
        expect(await vinculo(id)).toMatchObject({ pasa: null });
        await llamar("PATCH", { id, pasa: "home" });
        await llamar("PATCH", { id, status: "live" });
        expect(await vinculo(id)).toMatchObject({ pasa: null });
      });

      it("un adoptado: un marcador nuevo con ganador, sin pasa, deja pasa en null", async () => {
        await adoptado();
        await llamar("PATCH", { id: "espn-1", homeGoals90: 1, awayGoals90: 1, pasa: "home" });
        await llamar("PATCH", { id: "espn-1", homeGoals90: 2, awayGoals90: 0 });
        await llamar("PATCH", { id: "espn-1", homeGoals90: 1, awayGoals90: 1 });
        expect(await vinculo("espn-1")).toMatchObject({ pasa: null });
      });

      it("con un ganador a 90', pasa coherente no se guarda: no reaparece si luego el resultado pasa a empate", async () => {
        await adoptado();
        await llamar("PATCH", { id: "espn-1", homeGoals90: 2, awayGoals90: 1 });
        expect(await llamar("PATCH", { id: "espn-1", pasa: "home" })).toMatchObject({ status: 200 });
        expect(await vinculo("espn-1")).toMatchObject({ pasa: null });
        await llamar("PATCH", { id: "espn-1", homeGoals90: 2, awayGoals90: 2 });
        expect(await vinculo("espn-1")).toMatchObject({ pasa: null });
      });

      it("con un ganador a 90', pasa que lo contradice responde 409 pasa_inconsistente y no escribe", async () => {
        await adoptado();
        expect(await llamar("PATCH", { id: "espn-1", homeGoals90: 2, awayGoals90: 1, pasa: "away" })).toMatchObject({ status: 409, body: { error: "pasa_inconsistente" } });
        expect(await vinculo("espn-1")).toMatchObject({ home_goals_90: null, pasa: null });
        await llamar("PATCH", { id: "espn-1", homeGoals90: 2, awayGoals90: 1 });
        expect(await llamar("PATCH", { id: "espn-1", pasa: "away" })).toMatchObject({ status: 409, body: { error: "pasa_inconsistente" } });
        // En un manual, igual
        const { body } = await llamar("POST", { ...cruce, horario: "2026-11-22T10:00" });
        await llamar("PATCH", { id: body.partido.id, status: "finished", homeScore: 0, awayScore: 3 });
        expect(await llamar("PATCH", { id: body.partido.id, pasa: "home" })).toMatchObject({ status: 409, body: { error: "pasa_inconsistente" } });
      });

      it("valida el valor, no se mezcla con otros cambios y exige que el partido haya empezado", async () => {
        await adoptado();
        for (const pasa of ["empate", "", 1, true]) {
          expect(await llamar("PATCH", { id: "espn-1", pasa })).toMatchObject({ status: 400, body: { error: "pasa_invalido" } });
        }
        expect(await llamar("PATCH", { id: "espn-1", pasa: "home", fase: "final" })).toMatchObject({ status: 400, body: { error: "cambios_mezclados" } });
        expect(await llamar("PATCH", { id: "espn-1", pasa: "home", status: "finished", homeScore: 1, awayScore: 1 })).toMatchObject({ status: 400, body: { error: "cambios_mezclados" } });
        vi.setSystemTime(new Date("2026-11-20T15:00:00Z"));
        expect(await llamar("PATCH", { id: "espn-1", pasa: "home" })).toMatchObject({ status: 409, body: { error: "partido_no_empezado" } });
        expect(await vinculo("espn-1")).toMatchObject({ pasa: null });
      });

      it("404 fuera del prode", async () => {
        expect(await llamar("PATCH", { id: "no-existe", pasa: "home" })).toMatchObject({ status: 404, body: { error: "partido_inexistente" } });
      });
    });

    // docs/37 §2: ESPN puede traer alargue, penales o un resultado administrativo; el admin confirma el de 90'
    describe("PATCH {id, homeGoals90, awayGoals90}: resultado a los 90 minutos de un adoptado", () => {
      const adoptado = async () => {
        await espn();
        await llamar("POST", { adoptar: "espn-1", fase: "cuartos" });
      };

      it("lo fija en el vínculo sin tocar la fila de matches y lo muestra como resultado", async () => {
        await adoptado();
        await t.DB.prepare("UPDATE matches SET status = 'finished', home_score = 3, away_score = 2 WHERE id = 'espn-1'").run();
        const antes = await fila("espn-1");
        vi.setSystemTime(DESPUES);
        const res = await llamar("PATCH", { id: "espn-1", homeGoals90: 2, awayGoals90: 2 });
        expect(res.status).toBe(200);
        expect(res.body.partido).toMatchObject({ id: "espn-1", resultado: { local: 2, visitante: 2 } });
        expect(await vinculo("espn-1")).toMatchObject({ home_goals_90: 2, away_goals_90: 2 });
        expect(await fila("espn-1")).toEqual(antes);
      });

      it("sin resultado a 90 confirmado, un adoptado no muestra resultado aunque ESPN tenga marcador", async () => {
        await adoptado();
        await t.DB.prepare("UPDATE matches SET status = 'finished', home_score = 3, away_score = 2 WHERE id = 'espn-1'").run();
        const res = await GET(apiCtx({ url: "https://fisture.test/api/admin/prode/partidos", headers: { Authorization: `Bearer ${ADMIN}` }, env: { ENVIRONMENT: "test", DB: t.DB, KV: kvEnMemoria(), ADMIN_SECRET: ADMIN } }));
        expect(((await res.json()) as any).partidos[0].resultado).toBeNull();
      });

      it("valida goles enteros 0-20, ambos juntos y sin mezclar con otros cambios", async () => {
        await adoptado();
        vi.setSystemTime(DESPUES);
        for (const goles of [{ homeGoals90: -1, awayGoals90: 0 }, { homeGoals90: 21, awayGoals90: 0 }, { homeGoals90: 1.5, awayGoals90: 0 }, { homeGoals90: "1", awayGoals90: 0 }]) {
          expect(await llamar("PATCH", { id: "espn-1", ...goles })).toMatchObject({ status: 400, body: { error: "marcador_invalido" } });
        }
        expect(await llamar("PATCH", { id: "espn-1", homeGoals90: 1 })).toMatchObject({ status: 400, body: { error: "faltan_goles" } });
        expect((await llamar("PATCH", { id: "espn-1", homeGoals90: 1, awayGoals90: 0, fase: "final" })).status).toBe(400);
        expect(await vinculo("espn-1")).toMatchObject({ home_goals_90: null, away_goals_90: null });
      });

      it("409 partido_no_empezado antes del horario, 404 fuera del prode y 409 en un cruce manual", async () => {
        await adoptado();
        expect(await llamar("PATCH", { id: "espn-1", homeGoals90: 1, awayGoals90: 0 })).toMatchObject({ status: 409, body: { error: "partido_no_empezado" } });
        await t.DB.prepare("INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, source) VALUES ('espn-2', 'espn:2', 'edlp', 'boca', 'lpf', 1700000000, 'espn')").run();
        expect(await llamar("PATCH", { id: "espn-2", homeGoals90: 1, awayGoals90: 0 })).toMatchObject({ status: 404, body: { error: "partido_inexistente" } });
        const { body } = await llamar("POST", { ...cruce, horario: "2026-11-29T21:00" });
        // En un manual el resultado a 90' es el de matches: se carga con {status: "finished", homeScore, awayScore}
        expect(await llamar("PATCH", { id: body.partido.id, homeGoals90: 1, awayGoals90: 0 })).toMatchObject({ status: 409, body: { error: "partido_manual" } });
      });
    });
  });

  describe("cruces duplicados (ventana de 6 horas, misma liga y mismos equipos)", () => {
    const espn = (id: string, iso: string) =>
      t.DB.prepare("INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, source) VALUES (?, ?, 'boca', 'edlp', 'lpf', ?, 'espn')")
        .bind(id, `espn:${id}`, Date.parse(iso) / 1000)
        .run();
    const cuenta = async () => (await t.DB.prepare("SELECT COUNT(*) AS n FROM matches").first<any>()).n;

    it("POST rechaza un cruce manual repetido con 409 y el id del existente", async () => {
      const primero = await llamar("POST", cruce);
      const res = await llamar("POST", { ...cruce, horario: "2026-11-22T18:00" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "cruce_duplicado", existente: { id: primero.body.partido.id, source: "manual" } });
      expect(await cuenta()).toBe(1);
    });

    it("POST rechaza un cruce que ya trajo el sync de ESPN", async () => {
      await espn("espn-1", "2026-11-23T00:30:00Z");
      const res = await llamar("POST", cruce);
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "cruce_duplicado", existente: { id: "espn-1", source: "espn" } });
      expect(await cuenta()).toBe(1);
    });

    it("la ventana es de menos de 6 h: a 5:59 es duplicado, a 6:00 no", async () => {
      await llamar("POST", cruce);
      for (const horario of ["2026-11-22T15:01", "2026-11-23T02:59"]) expect((await llamar("POST", { ...cruce, horario })).status).toBe(409);
      expect((await llamar("POST", { ...cruce, horario: "2026-11-22T15:00" })).status).toBe(201);
      expect((await llamar("POST", { ...cruce, horario: "2026-11-23T03:00" })).status).toBe(201);
    });

    it("POST permite los mismos equipos con dos días de diferencia (ida y vuelta)", async () => {
      await llamar("POST", cruce);
      expect((await llamar("POST", { ...cruce, horario: "2026-11-24T21:00" })).status).toBe(201);
    });

    it("POST permite los equipos invertidos: es otro partido", async () => {
      await llamar("POST", cruce);
      expect((await llamar("POST", { ...cruce, homeTeamId: "edlp", awayTeamId: "boca" })).status).toBe(201);
    });

    it("POST permite el mismo cruce en otra liga", async () => {
      await t.DB.prepare("INSERT INTO leagues (id, external_id, name, country, season) VALUES ('copa', 'espn:copa', 'Copa', 'Argentina', 2026)").run();
      await llamar("POST", cruce);
      expect((await llamar("POST", { ...cruce, leagueId: "copa" })).status).toBe(201);
    });

    it("PATCH rechaza mover un cruce encima de otro y no escribe", async () => {
      const a = await llamar("POST", cruce);
      const b = await llamar("POST", { ...cruce, horario: "2026-11-26T21:00" });
      const antes = await fila(b.body.partido.id);
      const res = await llamar("PATCH", { id: b.body.partido.id, horario: "2026-11-22T20:00" });
      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "cruce_duplicado", existente: { id: a.body.partido.id, source: "manual" } });
      expect(await fila(b.body.partido.id)).toEqual(antes);
    });

    it("PATCH rechaza mover un cruce encima de uno de ESPN", async () => {
      await espn("espn-1", "2026-11-28T00:00:00Z");
      const { body } = await llamar("POST", cruce);
      const res = await llamar("PATCH", { id: body.partido.id, horario: "2026-11-27T22:00" });
      expect(res.status).toBe(409);
      expect(res.body.existente).toEqual({ id: "espn-1", source: "espn" });
    });

    it("PATCH no se choca consigo mismo al corregir unos minutos", async () => {
      const { body } = await llamar("POST", cruce);
      expect((await llamar("PATCH", { id: body.partido.id, horario: "2026-11-22T21:30" })).status).toBe(200);
    });
  });
});
