// Sync y reconciliación con tokens cifrados (docs/15 revisión): el token se descifra antes de llegar al
// proveedor, uno ilegible deja al usuario en reauth_required y la falta de clave corta la corrida sin marcar a nadie.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../../helpers/d1";
import { relojFijo } from "../../helpers/clock";
import { clienteFalso, fila, insertarSync, sembrar, setMatch, T0, usuario } from "../../helpers/calendar";
import { createDb, type Database } from "../../../src/lib/db";
import { reconcileCalendarBatch } from "../../../src/lib/calendar/reconcile";
import { syncMatches } from "../../../src/lib/calendar/sync-service";
import { CalendarApiError } from "../../../src/lib/calendar/errors";
import { encryptToken, TokenKeyError } from "../../../src/lib/auth/token-crypto";
import { claro, ENV_CON_CLAVE, nuevaClave } from "../../helpers/token-key";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../../src/lib/auth/providers", () => ({
  createGoogleProvider: () => ({ refreshAccessToken: refresh }),
  createMicrosoftProvider: () => ({ refreshAccessToken: refresh }),
}));

const AHORA = new Date((T0 - 86_400) * 1000);

describe("tokens cifrados en sync y reconciliación", () => {
  relojFijo(AHORA);
  let t: TestDb;
  let db: Database;
  let falso: ReturnType<typeof clienteFalso>;

  const cifrado = (id: string, columna: "access_token" | "refresh_token", valor: string, env = ENV_CON_CLAVE) =>
    encryptToken(env, valor, `${id}:${columna}`);
  const guardarTokens = async (id: string, access: string, refreshT: string | null, expira: number) =>
    t.DB.prepare("UPDATE users SET access_token = ?, refresh_token = ?, token_expires_at = ? WHERE id = ?").bind(access, refreshT, expira, id).run();
  const columna = async (id: string, col: string) => (await t.DB.prepare(`SELECT ${col} AS v FROM users WHERE id = ?`).bind(id).first<{ v: unknown }>())?.v;
  const lote = (env: Env = ENV_CON_CLAVE) =>
    reconcileCalendarBatch(env, db, { client: falso.client }, { now: AHORA, marcarDesactualizados: true });

  beforeAll(async () => {
    t = await createTestDb();
    db = createDb(t.DB);
  });
  afterAll(async () => {
    await t.dispose();
  });
  beforeEach(async () => {
    refresh.mockReset().mockResolvedValue({ accessToken: () => "nuevo", accessTokenExpiresAt: () => new Date(AHORA.getTime() + 3_600_000), refreshToken: () => "rt-nuevo" });
    await sembrar(t, ["m1", "m2"]);
    falso = clienteFalso();
    await insertarSync(t, { id: "s1", match: "m1" });
    await setMatch(t, "m1", { dateTime: T0 + 60 });
  });

  it("forzar renovación: el proveedor recibe el refresh descifrado, nunca el texto cifrado", async () => {
    const expira = AHORA.getTime() + 3_600_000;
    await guardarTokens("u1", await cifrado("u1", "access_token", "at-vigente"), await cifrado("u1", "refresh_token", "rt-guardado"), expira);
    falso.fallos.update = () => (falso.llamadas.update === 1 ? new CalendarApiError("unauthorized", 401) : null);
    const tokens: string[] = [];
    const actualizar = falso.client.update;
    falso.client.update = async (token, ...resto) => (tokens.push(token), actualizar(token, ...resto));

    const [r] = await syncMatches(db, ENV_CON_CLAVE, await usuario(db, "u1"), ["m1"], { mode: "auto", deps: { client: falso.client } });
    expect(r.success).toBe(true);
    expect(tokens).toEqual(["at-vigente", "nuevo"]); // en claro, nunca enc:v1:
    expect(refresh).toHaveBeenCalledWith("rt-guardado");
    expect(await claro(String(await columna("u1", "refresh_token")), "u1", "refresh_token")).toBe("rt-nuevo");
  });

  it("reconcile con tokens cifrados usa el access descifrado", async () => {
    await guardarTokens("u1", await cifrado("u1", "access_token", "at-claro"), await cifrado("u1", "refresh_token", "rt"), AHORA.getTime() + 3_600_000);
    const tokens: string[] = [];
    const actualizar = falso.client.update;
    falso.client.update = async (token, ...resto) => (tokens.push(token), actualizar(token, ...resto));
    await lote();
    expect(tokens).toEqual(["at-claro"]);
    expect((await fila(t, "m1")).status).toBe("synced");
  });

  it("un token ilegible deja al usuario en reauth_required y el evento sin marcar failed", async () => {
    const ajeno = await cifrado("u1", "access_token", "at", { TOKEN_ENCRYPTION_KEY: nuevaClave() } as Env);
    await guardarTokens("u1", ajeno, null, AHORA.getTime() + 3_600_000);
    const r = await lote();
    expect(r.sinAcceso).toBe(1);
    expect(await columna("u1", "calendar_auth_status")).toBe("reauth_required");
    expect((await fila(t, "m1")).status).toBe("needs_update");
    expect(falso.llamadas.update).toBe(0);
  });

  it("sin clave: corta la corrida, no marca a nadie ni toca los eventos, y no llama al proveedor", async () => {
    await guardarTokens("u1", await cifrado("u1", "access_token", "at"), await cifrado("u1", "refresh_token", "rt"), AHORA.getTime() - 1000);
    await expect(lote({} as Env)).rejects.toBeInstanceOf(TokenKeyError);
    expect(await columna("u1", "calendar_auth_status")).toBe("ok");
    expect(await columna("u1", "calendar_reconciled_at")).toBeNull();
    expect((await fila(t, "m1")).status).toBe("needs_update");
    expect(refresh).not.toHaveBeenCalled();
    expect(falso.llamadas.update).toBe(0);
  });

  it("sin clave en un sync manual: resultado config, sin tokenInvalido y sin fila failed", async () => {
    const [r] = await syncMatches(db, {} as Env, await usuario(db, "u1"), ["m1"], { mode: "manual", deps: { client: falso.client } });
    expect(r).toMatchObject({ success: false, code: "config" });
    expect(r.tokenInvalido).toBeUndefined();
    expect((await fila(t, "m1")).status).not.toBe("failed");
  });
});
