// Puntaje del sync (docs/37 §3.5): un batch de D1 que puntúa, corrige y anula.
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import { useTestDb } from "../../helpers/use-test-db";
import { AHORA, DIA_MS, relojFijo } from "../../helpers/clock";
import { pronosticoDirecto, sembrarProde, seg } from "../../helpers/prode";
import { puntuarPronosticos, VENTANA_PUNTAJE_DIAS } from "../../../src/lib/prode/puntuar";
import { puntosDe } from "../../../src/lib/prode/reglas";
import { crearGrupo, grupoPorCodigo } from "../../../src/lib/prode/repo";
import { deleteAccount } from "../../../src/lib/db/account";

function contarBatch(DB: D1Database) {
  const llamadas = { prepare: 0, batch: 0 };
  const espia = new Proxy(DB, {
    get(target, prop) {
      if (prop === "batch") llamadas.batch++;
      const v = Reflect.get(target, prop);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  return { DB: espia, llamadas };
}

describe("puntuarPronosticos", () => {
  const t = useTestDb();
  relojFijo();

  beforeEach(async () => {
    await sembrarProde(t.DB);
  });

  const puntos = async (userId: string, matchId: string) =>
    (await t.DB.prepare("SELECT points FROM prode_predictions WHERE user_id = ?1 AND match_id = ?2").bind(userId, matchId).first<{ points: number | null }>())?.points;

  it("el SQL da lo mismo que puntosDe para toda la matriz de 0 a 3 goles", async () => {
    const goles = [0, 1, 2, 3];
    const marcadores = goles.flatMap((l) => goles.map((v) => ({ local: l, visitante: v })));
    const usuarios = marcadores.map((_, i) => `m${i}`);
    await t.DB.batch([
      ...usuarios.map((u) => t.DB.prepare("INSERT INTO users (id, email, provider, provider_id) VALUES (?1, ?2, 'google', ?1)").bind(u, `${u}@example.test`)),
      ...marcadores.map((r, i) =>
        t.DB.prepare(
          "INSERT INTO matches (id, external_id, home_team_id, away_team_id, league_id, date_time, status, home_score, away_score, updated_at) VALUES (?1, ?1, 'river', 'boca', 'lpf', ?2, 'finished', ?3, ?4, ?5)"
        ).bind(`r${i}`, seg(AHORA.getTime() - DIA_MS), r.local, r.visitante, seg(AHORA.getTime() - DIA_MS))
      ),
    ]);
    await t.DB.batch(
      marcadores.flatMap((_, m) =>
        marcadores.map((p, u) =>
          t.DB.prepare("INSERT INTO prode_predictions (user_id, match_id, home_goals, away_goals, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 1, 1)").bind(usuarios[u], `r${m}`, p.local, p.visitante)
        )
      )
    );

    const r = await puntuarPronosticos(t.DB, AHORA);
    expect(r).toEqual({ puntuados: 256, anulados: 0, gruposVacios: 0 });

    const { results } = await t.DB.prepare("SELECT user_id, match_id, points FROM prode_predictions WHERE match_id LIKE 'r%'").all<{ user_id: string; match_id: string; points: number }>();
    expect(results).toHaveLength(256);
    for (const fila of results) {
      const p = marcadores[Number(fila.user_id.slice(1))];
      const res = marcadores[Number(fila.match_id.slice(1))];
      expect(fila.points, `${JSON.stringify(p)} vs ${JSON.stringify(res)}`).toBe(puntosDe(p, res));
    }
  });

  it("solo puntúa terminados con los dos goles; es idempotente y usa un solo batch", async () => {
    await pronosticoDirecto(t.DB, "ana", "terminado-1", 2, 1);
    await pronosticoDirecto(t.DB, "ana", "terminado-2", 1, 0);
    await pronosticoDirecto(t.DB, "ana", "sin-marcador", 1, 0);
    await pronosticoDirecto(t.DB, "ana", "en-juego", 1, 0);
    await pronosticoDirecto(t.DB, "ana", "abierto-1", 1, 0);
    await pronosticoDirecto(t.DB, "ana", "cancelado", 1, 0);

    const { DB, llamadas } = contarBatch(t.DB);
    expect(await puntuarPronosticos(DB, AHORA)).toEqual({ puntuados: 2, anulados: 0, gruposVacios: 0 });
    expect(llamadas.batch).toBe(1);
    expect(await puntos("ana", "terminado-1")).toBe(3);
    expect(await puntos("ana", "terminado-2")).toBe(0);
    for (const m of ["sin-marcador", "en-juego", "abierto-1", "cancelado"]) expect(await puntos("ana", m)).toBeNull();

    expect(await puntuarPronosticos(t.DB, AHORA)).toEqual({ puntuados: 0, anulados: 0, gruposVacios: 0 });
  });

  it("si la fuente corrige el resultado, vuelve a puntuar", async () => {
    await pronosticoDirecto(t.DB, "ana", "terminado-1", 2, 1);
    await puntuarPronosticos(t.DB, AHORA);
    expect(await puntos("ana", "terminado-1")).toBe(3);

    // El sync actualiza matches.updated_at solo cuando algo cambió (data-providers/sync.ts)
    await t.DB.prepare("UPDATE matches SET home_score = 1, away_score = 1, updated_at = ?1 WHERE id = 'terminado-1'").bind(seg(AHORA) + 60).run();
    const despues = new Date(AHORA.getTime() + 120_000);
    expect(await puntuarPronosticos(t.DB, despues)).toEqual({ puntuados: 1, anulados: 0, gruposVacios: 0 });
    expect(await puntos("ana", "terminado-1")).toBe(0);
  });

  it("anula los puntos si el partido deja de estar terminado o pierde el marcador", async () => {
    await pronosticoDirecto(t.DB, "ana", "terminado-1", 2, 1);
    await pronosticoDirecto(t.DB, "beto", "terminado-2", 0, 0);
    await puntuarPronosticos(t.DB, AHORA);
    await t.DB.batch([
      t.DB.prepare("UPDATE matches SET status = 'cancelled' WHERE id = 'terminado-1'"),
      t.DB.prepare("UPDATE matches SET home_score = NULL WHERE id = 'terminado-2'"),
    ]);
    expect(await puntuarPronosticos(t.DB, AHORA)).toEqual({ puntuados: 0, anulados: 2, gruposVacios: 0 });
    expect(await puntos("ana", "terminado-1")).toBeNull();
    expect(await puntos("beto", "terminado-2")).toBeNull();
  });

  it("borra los grupos que quedaron sin miembros (p. ej. el último borró su cuenta), en el mismo batch", async () => {
    const vacio = await crearGrupo(t.DB, { userId: "ana", nombre: "Se va", ligaId: "lpf", ahora: AHORA });
    const conGente = await crearGrupo(t.DB, { userId: "beto", nombre: "Se queda", ligaId: "lpf", ahora: AHORA });
    if (!vacio.ok || !conGente.ok) throw new Error("sin grupos");
    await deleteAccount(t.DB, "ana");
    const { DB, llamadas } = contarBatch(t.DB);
    expect(await puntuarPronosticos(DB, AHORA)).toEqual({ puntuados: 0, anulados: 0, gruposVacios: 1 });
    expect(llamadas.batch).toBe(1);
    expect(await grupoPorCodigo(t.DB, vacio.codigo)).toBeNull();
    expect(await grupoPorCodigo(t.DB, conGente.codigo)).not.toBeNull();
  });

  it(`no toca partidos de más de ${VENTANA_PUNTAJE_DIAS} días`, async () => {
    await pronosticoDirecto(t.DB, "ana", "viejo", 1, 0);
    expect(await puntuarPronosticos(t.DB, AHORA)).toEqual({ puntuados: 0, anulados: 0, gruposVacios: 0 });
    expect(await puntos("ana", "viejo")).toBeNull();
  });
});
