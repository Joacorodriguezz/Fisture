// POST/PATCH /api/admin/prode/partidos: carga manual de los cruces de playoffs y corrección de horario/fase.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { relojFijo } from "../../helpers/clock";
import { GET, PATCH, POST } from "../../../src/pages/api/admin/prode/partidos";

const ADMIN = "admin-de-prueba";

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
});
