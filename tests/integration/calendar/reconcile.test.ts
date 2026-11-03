// Reconciliación de calendarios por lotes (docs/17 D4): rotación justa, presupuesto de subrequests,
// usuarios con la autenticación caída y reglas de calendario (docs/11) que siguen valiendo.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "../../helpers/d1";
import { clienteFalso, fila, getToken, insertarSync, sembrar, setMatch, T0 } from "../../helpers/calendar";
import { createDb, type Database } from "../../../src/lib/db";
import { reconcileCalendarBatch, type ReconcileOptions } from "../../../src/lib/calendar/reconcile";
import { contarD1, Presupuesto } from "../../../src/lib/calendar/presupuesto";
import { CalendarApiError } from "../../../src/lib/calendar/errors";
import { ENV_VACIO } from "../../helpers/fixtures";

const AHORA = new Date((T0 - 86_400) * 1000);
const MS = AHORA.getTime();

describe("reconcileCalendarBatch", () => {
  let t: TestDb;
  let db: Database;
  let falso: ReturnType<typeof clienteFalso>;

  const lote = (opciones: ReconcileOptions = {}, getTokenFn: typeof getToken = getToken) =>
    reconcileCalendarBatch(ENV_VACIO, db, { client: falso.client, getToken: getTokenFn }, { now: AHORA, marcarDesactualizados: true, ...opciones });

  const seguir = (userId: string, teamId = "t1") =>
    t.DB.prepare("INSERT INTO user_teams (id, user_id, team_id, auto_sync) VALUES (?, ?, ?, 1)").bind(`ut-${userId}`, userId, teamId).run();
  const nuevoUsuario = (id: string) =>
    t.DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES (?, ?, ?, 'google', ?)").bind(id, `${id}@x`, id, `g-${id}`).run();
  const columna = async (id: string, col: string) =>
    (await t.DB.prepare(`SELECT ${col} AS v FROM users WHERE id = ?`).bind(id).first<{ v: unknown }>())?.v;
  // Un evento por usuario pendiente de corrección, con el partido reprogramado
  const pendiente = async (user: string, match = "m1", id = `s-${user}-${match}`) => {
    await insertarSync(t, { id, match, user });
  };
  const reprogramar = (...ms: string[]) => Promise.all(ms.map((m) => setMatch(t, m, { dateTime: T0 + 60 })));

  beforeAll(async () => {
    t = await createTestDb();
    db = createDb(t.DB);
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    await sembrar(t, ["m1", "m2", "m3", "m4"]);
    falso = clienteFalso();
  });

  describe("reglas de calendario (docs/11)", () => {
    it("B8: un usuario sin auto-sync con un evento manual reprogramado se corrige igual", async () => {
      await insertarSync(t, { id: "s1", match: "m1" });
      await setMatch(t, "m1", { dateTime: T0 + 3600 });
      await lote();
      expect(falso.llamadas.update).toBe(1);
      expect(await fila(t, "m1")).toMatchObject({ status: "synced", synced_date_time: T0 + 3600 });
    });

    it("detecta la reprogramación sin pasar por una vista de página (markOutdated global)", async () => {
      await insertarSync(t, { id: "s1", match: "m1", user: "u1" });
      await insertarSync(t, { id: "s2", match: "m1", user: "u2" });
      await setMatch(t, "m1", { venue: "Otra cancha" });
      await lote();
      expect(falso.llamadas.update).toBe(2);
    });

    it("sin marcarDesactualizados no revisa los eventos (lo hace solo el primer lote del barrido)", async () => {
      await insertarSync(t, { id: "s1", match: "m1" });
      await setMatch(t, "m1", { dateTime: T0 + 3600 });
      await lote({ marcarDesactualizados: false });
      expect(falso.llamadas.update).toBe(0);
    });

    it("un usuario con auto-sync recibe también los partidos nuevos de su equipo", async () => {
      await seguir("u1");
      await lote();
      expect(falso.llamadas.create).toBe(4);
    });

    it("no recrea lo que el usuario borró: queda detached", async () => {
      await insertarSync(t, { id: "s1", match: "m1" });
      await setMatch(t, "m1", { dateTime: T0 + 60 });
      falso.fallos.update = () => new CalendarApiError("gone", 410);
      await lote();
      expect(falso.llamadas.create).toBe(0);
      expect((await fila(t, "m1")).status).toBe("detached");
    });

    it("no reofrece los partidos detached ni los cancelled del auto-sync", async () => {
      await seguir("u1");
      await insertarSync(t, { id: "s1", match: "m1", status: "detached", event: null });
      await insertarSync(t, { id: "s2", match: "m2", status: "cancelled", event: null, state: "cancelled" });
      await setMatch(t, "m2", { status: "cancelled" });
      await lote();
      expect(falso.llamadas.create).toBe(2); // solo m3 y m4
      expect((await fila(t, "m1")).status).toBe("detached");
    });

    it("D12: las correcciones van antes que las altas dentro del tope por turno", async () => {
      await seguir("u1");
      await insertarSync(t, { id: "s4", match: "m4" });
      await setMatch(t, "m4", { dateTime: T0 + 60 });
      await lote({ matchesPerUser: 2 });
      expect(falso.llamadas.update).toBe(1); // m4 se corrigió aunque sea el último por fecha
      expect(falso.llamadas.create).toBe(1);
      expect((await fila(t, "m4")).status).toBe("synced");
    });

    it("reintenta los failed", async () => {
      await insertarSync(t, { id: "s1", match: "m1", status: "failed" });
      await lote();
      expect(falso.llamadas.update).toBe(1);
      expect((await fila(t, "m1")).status).toBe("synced");
    });

    it("un error transitorio no crea eventos nuevos: la fila queda failed y se reintenta en otro barrido", async () => {
      await insertarSync(t, { id: "s1", match: "m1" });
      await setMatch(t, "m1", { dateTime: T0 + 60 });
      falso.fallos.update = () => new CalendarApiError("boom", 503);
      const resumen = await lote();
      expect(falso.llamadas.create).toBe(0);
      expect((await fila(t, "m1")).status).toBe("failed");
      expect(resumen).toMatchObject({ usuarios: 1, eventosOk: 0, eventosFallidos: 1, sinAcceso: 0 });
    });
  });

  describe("rotación justa (B3)", () => {
    beforeEach(async () => {
      for (const u of ["u3", "u4", "u5", "u6"]) await nuevoUsuario(u);
      for (const u of ["u1", "u2", "u3", "u4", "u5", "u6"]) await pendiente(u);
      await reprogramar("m1");
    });

    it("C-01: con lugar para 2 usuarios por lote, tres lotes del mismo barrido atienden a los 6, uno por vez", async () => {
      const r1 = await lote({ maxUsers: 2, corte: MS });
      expect(r1).toMatchObject({ usuarios: 2, quedan: true });
      const r2 = await lote({ maxUsers: 2, corte: MS, marcarDesactualizados: false });
      expect(r2).toMatchObject({ usuarios: 2, quedan: true });
      const r3 = await lote({ maxUsers: 2, corte: MS, marcarDesactualizados: false });
      expect(r3).toMatchObject({ usuarios: 2, quedan: true }); // llenó el lote: puede haber más
      const r4 = await lote({ maxUsers: 2, corte: MS, marcarDesactualizados: false });
      expect(r4).toMatchObject({ usuarios: 0, quedan: false });
      expect(falso.llamadas.update).toBe(6);
      for (const u of ["u1", "u2", "u3", "u4", "u5", "u6"]) expect(await columna(u, "calendar_reconciled_at")).toBe(MS);
    });

    it("C-02: quien siempre tiene trabajo (eventos failed que se reintentan a diario) no desplaza a los demás", async () => {
      const orden: string[] = [];
      for (let barrido = 0; barrido < 2; barrido++) {
        const corte = MS + barrido * 3_600_000;
        for (let i = 0; i < 6; i++) {
          const antes = await t.DB.prepare("SELECT id FROM users WHERE calendar_reconciled_at = ?").bind(corte).all<{ id: string }>();
          await lote({ maxUsers: 1, corte, now: new Date(corte), marcarDesactualizados: barrido === 0 && i === 0 });
          const despues = await t.DB.prepare("SELECT id FROM users WHERE calendar_reconciled_at = ?").bind(corte).all<{ id: string }>();
          const nuevo = despues.results.map((r) => r.id).filter((id) => !antes.results.some((a) => a.id === id));
          orden.push(...nuevo);
          // Deja los eventos de nuevo pendientes: simula un usuario que siempre tiene trabajo
          await t.DB.prepare("UPDATE calendar_syncs SET status = 'failed'").run();
        }
      }
      expect(orden).toEqual(["u1", "u2", "u3", "u4", "u5", "u6", "u1", "u2", "u3", "u4", "u5", "u6"]);
    });

    it("C-03: un usuario nuevo (nunca atendido) va antes que los ya atendidos", async () => {
      for (const u of ["u1", "u2", "u3", "u5", "u6"]) await t.DB.prepare("UPDATE users SET calendar_reconciled_at = ? WHERE id = ?").bind(MS - 86_400_000, u).run();
      await lote({ maxUsers: 1 });
      expect(await columna("u4", "calendar_reconciled_at")).toBe(MS);
      expect(await columna("u1", "calendar_reconciled_at")).toBe(MS - 86_400_000);
    });

    it("C-12: con el mismo calendar_reconciled_at se desempata por id", async () => {
      await t.DB.prepare("UPDATE users SET calendar_reconciled_at = ?").bind(MS - 3_600_000).run();
      await lote({ maxUsers: 1 });
      expect(await columna("u1", "calendar_reconciled_at")).toBe(MS);
      expect(await columna("u2", "calendar_reconciled_at")).toBe(MS - 3_600_000);
    });

    it("sin corte solo se atiende a quien no se atendió desde 'ahora': nunca se repite un usuario en el mismo barrido", async () => {
      await lote({ maxUsers: 6, corte: MS });
      const repetido = await lote({ maxUsers: 6, corte: MS, marcarDesactualizados: false });
      expect(repetido.usuarios).toBe(0);
    });

    it("C-04: quien tiene auto-sync y nada que sincronizar no gasta lugar en el lote", async () => {
      await t.DB.prepare("DELETE FROM calendar_syncs").run();
      await nuevoUsuario("u7");
      await seguir("u7");
      // u7 ya tiene todo sincronizado
      for (const m of ["m1", "m2", "m3", "m4"]) await insertarSync(t, { id: `s7-${m}`, match: m, user: "u7", synced: m === "m1" ? T0 + 60 : T0 });
      const resumen = await lote({ maxUsers: 5 });
      expect(resumen.usuarios).toBe(0);
      expect(resumen.quedan).toBe(false);
    });
  });

  describe("tope por turno (C-06)", () => {
    it("un usuario con muchos partidos pendientes se atiende por tandas de matchesPerUser y no monopoliza", async () => {
      await sembrar(t, Array.from({ length: 25 }, (_, i) => `p${i}`));
      for (let i = 0; i < 25; i++) await insertarSync(t, { id: `s${i}`, match: `p${i}` });
      await reprogramar(...Array.from({ length: 25 }, (_, i) => `p${i}`));
      const r = await lote({ matchesPerUser: 10 });
      expect(r).toMatchObject({ usuarios: 1, eventosOk: 10 });
      expect(falso.llamadas.update).toBe(10);
      // Se marcó como atendido: en el mismo barrido no vuelve; en el siguiente sigue con los demás
      expect((await lote({ matchesPerUser: 10, marcarDesactualizados: false })).usuarios).toBe(0);
      const siguiente = await lote({ matchesPerUser: 10, now: new Date(MS + 3_600_000), marcarDesactualizados: false });
      expect(siguiente.eventosOk).toBe(10);
    });
  });

  describe("presupuesto de subrequests (B5, C-05, C-11)", () => {
    it("C-05: si se agota en medio de un usuario, no se lo marca como atendido y el próximo lote sigue", async () => {
      await sembrar(t, ["m1", "m2", "m3", "m4", "m5", "m6"]);
      for (const m of ["m1", "m2", "m3", "m4", "m5", "m6"]) await insertarSync(t, { id: `s-${m}`, match: m });
      await reprogramar("m1", "m2", "m3", "m4", "m5", "m6");
      const p = new Presupuesto(24);
      const dbContada = createDb(contarD1(t.DB, p));
      const r = await reconcileCalendarBatch(ENV_VACIO, dbContada, { client: falso.client, getToken }, { now: AHORA, presupuesto: p, marcarDesactualizados: true });
      expect(r.cortadoPorPresupuesto).toBe(true);
      expect(r.quedan).toBe(true);
      expect(falso.llamadas.update).toBeGreaterThan(0);
      expect(falso.llamadas.update).toBeLessThan(6);
      expect(await columna("u1", "calendar_reconciled_at")).toBeNull();
      // Con otro presupuesto el lote termina el trabajo del mismo usuario
      const r2 = await lote({ marcarDesactualizados: false });
      expect(r2.cortadoPorPresupuesto).toBe(false);
      expect(falso.llamadas.update).toBe(6);
      expect(await columna("u1", "calendar_reconciled_at")).toBe(MS);
    });

    it("sin lugar ni para empezar con un usuario, el lote lo informa y no toca a nadie", async () => {
      await pendiente("u1");
      await reprogramar("m1");
      const r = await lote({ presupuesto: new Presupuesto(10, 0) });
      expect(r).toMatchObject({ usuarios: 0, cortadoPorPresupuesto: true, quedan: true });
      expect(falso.llamadas.update).toBe(0);
    });

    it("C-11: cada consulta D1 y cada llamada al calendario suman: el lote no pasa el tope", async () => {
      for (const u of ["u3", "u4", "u5", "u6", "u7", "u8"]) await nuevoUsuario(u);
      for (const u of ["u1", "u2", "u3", "u4", "u5", "u6", "u7", "u8"]) {
        await insertarSync(t, { id: `a-${u}`, match: "m1", user: u });
        await insertarSync(t, { id: `b-${u}`, match: "m2", user: u });
      }
      await reprogramar("m1", "m2");
      // Contador independiente del que usa el lote: cuenta lo que realmente llega a D1
      let consultasD1 = 0;
      const crudo = new Proxy(t.DB, {
        get(target, prop, receiver) {
          if (prop === "prepare") {
            return (sql: string) => {
              const s = target.prepare(sql);
              const envolver = (st: any): any =>
                new Proxy(st, {
                  get(o, k) {
                    if (k === "bind") return (...a: unknown[]) => envolver(o.bind(...a));
                    if (["run", "all", "first", "raw"].includes(k as string)) return (...a: unknown[]) => (consultasD1++, o[k](...a));
                    return o[k];
                  },
                });
              return envolver(s);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }) as typeof t.DB;
      const p = new Presupuesto(45, 3);
      const r = await reconcileCalendarBatch(
        ENV_VACIO,
        createDb(contarD1(crudo, p)),
        { client: falso.client, getToken },
        { now: AHORA, presupuesto: p, marcarDesactualizados: true }
      );
      expect(r.subrequests).toBe(p.usado);
      expect(consultasD1 + falso.total()).toBeLessThanOrEqual(45);
      expect(p.usado).toBeLessThanOrEqual(45);
      expect(r.usuarios).toBeGreaterThan(0);
      expect(r.cortadoPorPresupuesto).toBe(true); // 8 usuarios x 2 partidos no entran en un lote
    });
  });

  describe("autenticación caída (B4, C-07, C-08)", () => {
    it("C-07: un 401 marca al usuario reauth_required, no marca los eventos como failed y no vuelve a la cola", async () => {
      await pendiente("u1");
      await pendiente("u2");
      await reprogramar("m1");
      falso.fallos.update = () => new CalendarApiError("unauthorized", 401);
      const r1 = await lote({ corte: MS });
      expect(r1).toMatchObject({ usuarios: 2, sinAcceso: 2 });
      expect(await columna("u1", "calendar_auth_status")).toBe("reauth_required");
      expect((await fila(t, "m1", "u1")).status).toBe("needs_update"); // no failed (docs/11 D4)
      // En un barrido posterior ya no es candidato
      falso.fallos.update = () => null;
      const r2 = await lote({ now: new Date(MS + 86_400_000), marcarDesactualizados: false });
      expect(r2.usuarios).toBe(0);
      expect(falso.llamadas.update).toBe(4); // por usuario: la llamada y el reintento tras renovar (docs/17 I2)
    });

    it("un error de autenticación de un usuario no frena a los demás", async () => {
      await pendiente("u1");
      await pendiente("u2");
      await reprogramar("m1");
      let rechazos = 0;
      falso.fallos.update = () => {
        if (rechazos >= 2) return null; // la llamada y el reintento de u1
        rechazos++;
        return new CalendarApiError("unauthorized", 401);
      };
      await lote();
      const estados = [(await fila(t, "m1", "u1")).status, (await fila(t, "m1", "u2")).status].sort();
      expect(estados).toEqual(["needs_update", "synced"]);
    });

    it("un usuario sin token de calendario también pasa a reauth_required", async () => {
      await pendiente("u1");
      await reprogramar("m1");
      const r = await lote({}, async () => {
        throw new Error("No calendar access token");
      });
      expect(r.sinAcceso).toBe(1);
      expect(await columna("u1", "calendar_auth_status")).toBe("reauth_required");
    });

    it("C-08: al volver a ok (inicio de sesión) el usuario reentra en la cola", async () => {
      await pendiente("u1");
      await reprogramar("m1");
      await t.DB.prepare("UPDATE users SET calendar_auth_status = 'reauth_required' WHERE id = 'u1'").run();
      expect((await lote()).usuarios).toBe(0);
      await t.DB.prepare("UPDATE users SET calendar_auth_status = 'ok', calendar_reconciled_at = NULL WHERE id = 'u1'").run();
      expect((await lote()).usuarios).toBe(1);
      expect((await fila(t, "m1")).status).toBe("synced");
    });
  });

  describe("límite de la API (C-09)", () => {
    it("rate_limit: el usuario se marca atendido, sigue pendiente y no pasa a reauth_required", async () => {
      await pendiente("u1");
      await reprogramar("m1");
      falso.fallos.update = () => new CalendarApiError("slow down", 429);
      const r = await lote();
      expect(r).toMatchObject({ usuarios: 1, sinAcceso: 0, eventosFallidos: 1 });
      expect(await columna("u1", "calendar_auth_status")).toBe("ok");
      expect(await columna("u1", "calendar_reconciled_at")).toBe(MS);
      expect((await fila(t, "m1")).status).toBe("needs_update");
    });
  });

  describe("robustez", () => {
    it("un usuario cuyo procesamiento explota se marca atendido y no bloquea a los demás", async () => {
      await pendiente("u1");
      await pendiente("u2");
      await reprogramar("m1");
      let n = 0;
      const r = await lote({}, async () => {
        if (n++ === 0) throw new TypeError("bug inesperado");
        return "token";
      });
      // El TypeError se clasifica transitorio (fila failed), el lote sigue con el otro usuario
      expect(r.usuarios).toBe(2);
      expect(await columna("u1", "calendar_reconciled_at")).toBe(MS);
      expect(await columna("u2", "calendar_reconciled_at")).toBe(MS);
    });

    it("quedan es false cuando se atendió a todos y el lote no se llenó", async () => {
      await pendiente("u1");
      await reprogramar("m1");
      expect(await lote({ maxUsers: 5 })).toMatchObject({ usuarios: 1, quedan: false, cortadoPorPresupuesto: false });
    });
  });
});
