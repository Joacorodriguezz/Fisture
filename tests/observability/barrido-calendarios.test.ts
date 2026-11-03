// Barrido completo de calendarios, de punta a punta: el script (scripts/sync-calendarios.mjs) contra el
// handler real de POST /api/admin/sync y una D1 real (docs/17, revisión B1 y M2). Solo se reemplazan
// el calendario y el token de Google.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { apiCtx, silenciarConsola } from "../helpers/ctx";
import { clienteFalso, insertarSync, sembrar, setMatch, T0 } from "../helpers/calendar";
import { CalendarApiError } from "../../src/lib/calendar/errors";
import { PARTIDOS_POR_TURNO } from "../../src/lib/calendar/reconcile";
import { getHealth } from "../../src/lib/observability/health";
import { getLatestRuns } from "../../src/lib/observability/sync-runs";
import { POST } from "../../src/pages/api/admin/sync";
import { sincronizarCalendarios } from "../../scripts/sync-calendarios.mjs";

const falso = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("../../src/lib/calendar/clients", () => ({ getClient: () => falso.client }));
vi.mock("../../src/lib/auth/tokens", () => ({ getValidAccessToken: async () => "token-falso" }));

const PARTIDOS = Array.from({ length: 12 }, (_, i) => `p${i}`);

describe("barrido de calendarios de punta a punta", () => {
  const t = useTestDb();
  let calendario: ReturnType<typeof clienteFalso>;
  let llamadasPorUsuario: Record<string, number>;

  const env = () => ({ DB: t.DB, KV: { get: async () => null }, ADMIN_SECRET: "s3", OAUTH_STATE_SECRET: "x", ENVIRONMENT: "production" });
  // El script habla con el handler como lo haría por HTTP
  const fetchAlHandler = (async (_url: string, init: RequestInit) =>
    POST(apiCtx({ url: "https://fisture.test/api/admin/sync", method: "POST", headers: init.headers as Record<string, string>, body: init.body as string, env: env() }))) as unknown as typeof fetch;
  const barrido = (extra: Record<string, unknown> = {}) =>
    sincronizarCalendarios({ appUrl: "https://fisture.test", adminSecret: "s3", fetchImpl: fetchAlHandler, esperar: async () => {}, log: () => {}, ...extra });
  // Entre barrido y barrido pasa tiempo real: el corte del siguiente es posterior a lo ya atendido
  const pasaElTiempo = () => new Promise((r) => setTimeout(r, 15));
  const estados = async (user: string) => {
    const { results } = await t.DB.prepare("SELECT status, COUNT(*) AS n FROM calendar_syncs WHERE user_id = ? GROUP BY status").bind(user).all<{ status: string; n: number }>();
    return Object.fromEntries(results.map((r) => [r.status, r.n]));
  };

  beforeEach(async () => {
    silenciarConsola(vi);
    calendario = clienteFalso();
    llamadasPorUsuario = {};
    const actualizar = calendario.client.update;
    calendario.client.update = async (token, eventId, match, prefs) => {
      const dueno = eventId.split("-")[1];
      llamadasPorUsuario[dueno] = (llamadasPorUsuario[dueno] ?? 0) + 1;
      // u2 tiene un problema permanente con su calendario en cada evento
      if (dueno === "u2") throw new CalendarApiError("Bad Request", 400);
      return actualizar(token, eventId, match, prefs);
    };
    falso.client = calendario.client;

    await sembrar(t as never, PARTIDOS);
    await t.DB.prepare("INSERT INTO users (id, email, name, provider, provider_id) VALUES ('u3','c@c','C','google','g3')").run();
    // u1: 12 eventos (más que un turno). u2: 6 que fallan siempre. u3: uno normal. Todos reprogramados.
    for (const m of PARTIDOS) await insertarSync(t as never, { id: `a-${m}`, match: m, user: "u1", event: `ev-u1-${m}` });
    for (const m of PARTIDOS.slice(0, 6)) await insertarSync(t as never, { id: `b-${m}`, match: m, user: "u2", event: `ev-u2-${m}` });
    await insertarSync(t as never, { id: "c-p0", match: "p0", user: "u3", event: "ev-u3-p0" });
    for (const m of PARTIDOS) await setMatch(t as never, m, { dateTime: T0 + 60 });
  });

  it("B1: un usuario con muchos pendientes y otro con fallas permanentes: el barrido avanza, termina y no abre incidente", async () => {
    const r = await barrido();
    // El script sale con 0 (sin `error`): el workflow no abre un issue
    expect(r.error).toBeUndefined();
    expect(r).toMatchObject({ completo: true });
    expect(r.usuarios).toBe(3);

    // u1 hizo un turno, u3 quedó al día y u2 falló sin trabar a nadie
    expect(await estados("u1")).toEqual({ synced: 12 - 12 + PARTIDOS_POR_TURNO, needs_update: 12 - PARTIDOS_POR_TURNO });
    expect(await estados("u3")).toEqual({ synced: 1 });
    expect(await estados("u2")).toMatchObject({ failed: PARTIDOS_POR_TURNO });
    expect(llamadasPorUsuario.u2).toBe(PARTIDOS_POR_TURNO);

    // Ningún lote quedó failed ni partial, y la salud de calendarios está bien
    const runs = await getLatestRuns(t.db, 20, "calendars");
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.every((x) => x.status === "success")).toBe(true);
    expect((await getHealth(env() as never)).checks.calendars).toBe("ok");
  });

  it("B1: en los barridos siguientes u1 termina sus 12 eventos y u2 no le quita el turno a nadie", async () => {
    for (let n = 0; n < 3; n++) {
      const r = await barrido();
      expect(r.error).toBeUndefined();
      expect(r.completo).toBe(true);
      await pasaElTiempo();
    }
    expect(await estados("u1")).toEqual({ synced: 12 });
    expect(await estados("u3")).toEqual({ synced: 1 });
    // u2 sigue fallando (nada lo arregla) pero nunca creó un evento nuevo
    expect(calendario.llamadas.create).toBe(0);
  });

  it("M2: avisar un barrido incompleto exige el corte y no hace trabajo", async () => {
    const llamar = (body: unknown) => POST(apiCtx({ url: "https://fisture.test/api/admin/sync", method: "POST", headers: { Authorization: "Bearer s3" }, body, env: env() }));
    expect((await llamar({ calendarios: true, incompleto: true })).status).toBe(400);
    const res = await llamar({ calendarios: true, corte: 5, incompleto: true });
    expect(await res.json()).toMatchObject({ success: true, status: "partial", siguiente: false, usuarios: 0, quedan: true });
    expect(calendario.total()).toBe(0);
  });

  it("M2: si el barrido llega al tope de lotes con usuarios pendientes queda un run partial visible en la salud", async () => {
    const r = await barrido({ maxLotes: 1 });
    expect(r.completo).toBe(false);
    expect(r.error).toBeUndefined(); // no es una falla: sigue en el próximo sync
    const [ultimo] = await getLatestRuns(t.db, 1, "calendars");
    expect(ultimo).toMatchObject({ status: "partial" });
    expect(ultimo.results[0]).toMatchObject({ quedan: true });
    expect((await getHealth(env() as never)).checks.calendars).toBe("degraded");
  });
});
