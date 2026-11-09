// Token de calendario durante syncMatches (docs/17, revisión): se obtiene una vez por invocación y
// un 401 fuerza una renovación y un único reintento antes de dar al usuario por sin acceso.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../helpers/d1";
import { relojFijo } from "../../helpers/clock";
import { clienteFalso, fila, insertarSync, sembrar, setMatch, T0, usuario } from "../../helpers/calendar";
import { createDb, type Database } from "../../../src/lib/db";
import { syncMatches } from "../../../src/lib/calendar/sync-service";
import { CalendarApiError } from "../../../src/lib/calendar/errors";
import { Presupuesto } from "../../../src/lib/calendar/presupuesto";
import { ENV_VACIO } from "../../helpers/fixtures";
import { claro } from "../../helpers/token-key";
import { encryptToken } from "../../../src/lib/auth/token-crypto";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../../src/lib/auth/providers", () => ({
  createGoogleProvider: () => ({ refreshAccessToken: refresh }),
  createMicrosoftProvider: () => ({ refreshAccessToken: refresh }),
}));

const AHORA = new Date((T0 - 86_400) * 1000);

describe("token y reintento ante 401", () => {
  relojFijo(AHORA);
  let t: TestDb;
  let db: Database;
  let falso: ReturnType<typeof clienteFalso>;

  const nuevoToken = (n: number) => ({ accessToken: () => `nuevo-${n}`, accessTokenExpiresAt: () => new Date(AHORA.getTime() + 3_600_000), refreshToken: () => `rt-${n}` });
  // Los tokens se guardan cifrados: desde el Release B un valor en claro es ilegible (docs/15 K18)
  const cifrar = (valor: string | null, columna: "access_token" | "refresh_token") => (valor === null ? null : encryptToken(ENV_VACIO, valor, `u1:${columna}`));
  const guardarTokens = async (access: string, refreshT: string | null, expira: number) =>
    t.DB.prepare("UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = 'u1'").bind(await cifrar(access, "access_token"), await cifrar(refreshT, "refresh_token"), expira).run();
  const vencerToken = () => guardarTokens("viejo", "rt-0", AHORA.getTime() - 1000);
  const vigenteToken = () => guardarTokens("vigente", "rt-0", AHORA.getTime() + 3_600_000);
  const columna = async (col: string) => (await t.DB.prepare(`SELECT ${col} AS v FROM users WHERE id = 'u1'`).first<{ v: unknown }>())?.v;
  const sync = async (ids: string[], opciones: { mode?: "auto" | "manual"; presupuesto?: Presupuesto } = {}) =>
    syncMatches(db, ENV_VACIO, await usuario(db, "u1"), ids, { mode: opciones.mode ?? "auto", presupuesto: opciones.presupuesto, deps: { client: falso.client } });

  beforeAll(async () => {
    t = await createTestDb();
    db = createDb(t.DB);
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    refresh.mockReset().mockResolvedValue(nuevoToken(1));
    await sembrar(t, ["m1", "m2", "m3"]);
    falso = clienteFalso();
  });

  it("I1: con el token vencido, N partidos renuevan una sola vez", async () => {
    await vencerToken();
    const r = await sync(["m1", "m2", "m3"]);
    expect(r.every((x) => x.success)).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(falso.llamadas.create).toBe(3);
  });

  it("I1: el token renovado se usa en las llamadas siguientes y se guarda el refresh token rotado", async () => {
    await vencerToken();
    const tokens: string[] = [];
    const crear = falso.client.create;
    falso.client.create = async (token, ...resto) => (tokens.push(token), crear(token, ...resto));
    await sync(["m1", "m2"]);
    expect(tokens).toEqual(["nuevo-1", "nuevo-1"]);
    expect(await claro(String(await columna("refresh_token")), "u1", "refresh_token")).toBe("rt-1");
  });

  it("con el token vigente no renueva", async () => {
    await vigenteToken();
    await sync(["m1", "m2"]);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("I2: un 401 con token 'vigente' fuerza una renovación y reintenta una vez con el token nuevo", async () => {
    await vigenteToken();
    await insertarSync(t, { id: "s1", match: "m1" });
    await setMatch(t, "m1", { dateTime: T0 + 60 });
    const usados: string[] = [];
    const actualizar = falso.client.update;
    falso.client.update = async (token, ...resto) => {
      usados.push(token);
      if (token === "vigente") throw new CalendarApiError("unauthorized", 401);
      return actualizar(token, ...resto);
    };
    const [r] = await sync(["m1"]);
    expect(r).toMatchObject({ matchId: "m1", success: true });
    expect(usados).toEqual(["vigente", "nuevo-1"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect((await fila(t, "m1")).status).toBe("synced");
  });

  it("I2: si tras renovar el 401 sigue, es auth: se corta, una sola renovación y ningún evento nuevo", async () => {
    await vigenteToken();
    await insertarSync(t, { id: "s1", match: "m1" });
    await insertarSync(t, { id: "s2", match: "m2" });
    await setMatch(t, "m1", { dateTime: T0 + 60 });
    await setMatch(t, "m2", { dateTime: T0 + 60 });
    falso.fallos.update = () => new CalendarApiError("unauthorized", 401);
    const r = await sync(["m1", "m2"]);
    expect(r.map((x) => x.code)).toEqual(["auth", "auth"]);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(falso.llamadas.update).toBe(2); // el original y el reintento
    expect(falso.llamadas.create).toBe(0);
    expect(await fila(t, "m1")).toMatchObject({ status: "synced", synced_date_time: T0 }); // sin tocar
  });

  it("I2: si la renovación falla con invalid_grant es auth y no se crea ni reintenta nada", async () => {
    await vigenteToken();
    await insertarSync(t, { id: "s1", match: "m1" });
    await setMatch(t, "m1", { dateTime: T0 + 60 });
    falso.fallos.update = () => new CalendarApiError("unauthorized", 401);
    refresh.mockRejectedValue(new Error("invalid_grant"));
    const [r] = await sync(["m1"]);
    expect(r).toMatchObject({ success: false, code: "auth" });
    expect(falso.llamadas.create).toBe(0);
  });

  it("I2: un 401 sin refresh token es auth sin intentar renovar", async () => {
    await guardarTokens("vigente", null, AHORA.getTime() + 3_600_000);
    await insertarSync(t, { id: "s1", match: "m1" });
    await setMatch(t, "m1", { dateTime: T0 + 60 });
    falso.fallos.update = () => new CalendarApiError("unauthorized", 401);
    const [r] = await sync(["m1"]);
    expect(r).toMatchObject({ success: false, code: "auth" });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("sin el permiso de calendario (403 insufficientPermissions) corta sin renovar ni marcar failed, y pide reconectar", async () => {
    await vigenteToken();
    falso.fallos.create = () => new CalendarApiError("Request had insufficient authentication scopes.", 403, { reason: "insufficientPermissions" });
    const r = await sync(["m1", "m2"], { mode: "manual" });
    expect(r.map((x) => x.code)).toEqual(["scope", "scope"]);
    expect(r.every((x) => x.tokenInvalido)).toBe(true);
    expect(r[0].error).toMatch(/permiso/i);
    expect(refresh).not.toHaveBeenCalled(); // renovar no agrega permisos
    expect(falso.llamadas.create).toBe(1);
    expect(await t.DB.prepare("SELECT COUNT(*) AS n FROM calendar_syncs WHERE status = 'failed'").first<{ n: number }>()).toEqual({ n: 0 });
  });

  it("un error transitorio (503) no reintenta ni crea un evento nuevo", async () => {
    await vigenteToken();
    await insertarSync(t, { id: "s1", match: "m1" });
    await setMatch(t, "m1", { dateTime: T0 + 60 });
    falso.fallos.update = () => new CalendarApiError("boom", 503);
    const [r] = await sync(["m1"]);
    expect(r).toMatchObject({ success: false, code: "transient" });
    expect(falso.llamadas.update).toBe(1);
    expect(falso.llamadas.create).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
  });

  it("presupuesto: cada renovación (la primera y la forzada) cuenta como una llamada de red", async () => {
    await vencerToken();
    await insertarSync(t, { id: "s1", match: "m1" });
    await setMatch(t, "m1", { dateTime: T0 + 60 });
    let primera = true;
    falso.fallos.update = () => {
      if (!primera) return null;
      primera = false;
      return new CalendarApiError("unauthorized", 401);
    };
    const p = new Presupuesto(100);
    await sync(["m1"], { presupuesto: p });
    // 2 renovaciones + el update original + el reintento = 4 llamadas de red (la D1 no está instrumentada acá)
    expect(p.usado).toBe(4);
  });

  it("M5: un sync manual exitoso devuelve a ok a un usuario en reauth_required; uno automático no", async () => {
    await vigenteToken();
    await t.DB.prepare("UPDATE users SET calendar_auth_status = 'reauth_required' WHERE id = 'u1'").run();
    await sync(["m1"], { mode: "auto" });
    expect(await columna("calendar_auth_status")).toBe("reauth_required");
    await sync(["m2"], { mode: "manual" });
    expect(await columna("calendar_auth_status")).toBe("ok");
  });

  it("M5: un sync manual que falla no reactiva al usuario", async () => {
    await vigenteToken();
    await t.DB.prepare("UPDATE users SET calendar_auth_status = 'reauth_required' WHERE id = 'u1'").run();
    falso.fallos.create = () => new CalendarApiError("unauthorized", 401);
    await sync(["m1"], { mode: "manual" });
    expect(await columna("calendar_auth_status")).toBe("reauth_required");
  });
});
