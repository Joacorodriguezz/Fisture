// Sesiones en D1 (docs/21-sesiones-en-d1-tdd.md, casos S1 a S7, S13, S15 y S18) contra D1 real de Miniflare.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { relojFijo } from "../../helpers/clock";
import { seedApp } from "../../helpers/fixtures";
import {
  countSessions,
  createSession,
  deleteSession,
  deleteUserSessions,
  getSessionUser,
  hashToken,
  purgeExpiredSessions,
} from "../../../src/lib/auth/session";

const DIA = 86_400;

describe("sesiones en D1", () => {
  const t = useTestDb();
  const ahora = relojFijo();
  const segundos = () => Math.floor(ahora.getTime() / 1000);
  const filas = async () => (await t.DB.prepare("SELECT * FROM sessions ORDER BY id").all<any>()).results;

  beforeEach(async () => {
    await seedApp(t.db);
  });

  it("S1: createSession guarda sha256(token), no el token, con 30 días de vida", async () => {
    const token = await createSession(t.db, "user-1");

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [fila] = await filas();
    expect(fila).toEqual({
      id: await hashToken(token),
      user_id: "user-1",
      created_at: segundos(),
      expires_at: segundos() + 30 * DIA,
    });
    expect(fila.id).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(await filas())).not.toContain(token);
  });

  it("S1: el hash es determinístico y 200 tokens son distintos", async () => {
    expect(await hashToken("abc")).toBe(await hashToken("abc"));
    expect(await hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const tokens = new Set<string>();
    for (let i = 0; i < 200; i++) tokens.add(await createSession(t.db, "user-1"));
    expect(tokens.size).toBe(200);
  });

  it("S1: usa crypto.getRandomValues y no Math.random", async () => {
    const mathRandom = vi.spyOn(Math, "random");
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");
    await createSession(t.db, "user-1");
    expect(mathRandom).not.toHaveBeenCalled();
    expect(getRandomValues).toHaveBeenCalled();
  });

  it("S2: getSessionUser con un token válido devuelve al dueño", async () => {
    const token = await createSession(t.db, "user-1");
    expect(await getSessionUser(t.db, token)).toMatchObject({ id: "user-1", email: "ana@example.test" });
  });

  it("S3: token desconocido o vacío devuelve null", async () => {
    await createSession(t.db, "user-1");
    expect(await getSessionUser(t.db, "inexistente")).toBeNull();
    expect(await getSessionUser(t.db, "")).toBeNull();
  });

  it("S4: una sesión expirada no resuelve aunque la fila exista", async () => {
    const token = await createSession(t.db, "user-1");
    const despues = new Date(ahora.getTime() + 30 * DIA * 1000 + 1000);
    expect(await getSessionUser(t.db, token, despues)).toBeNull();
    expect(await filas()).toHaveLength(1);
  });

  it("S5: con el usuario borrado la sesión no resuelve y no quedan huérfanas", async () => {
    const token = await createSession(t.db, "user-1");
    await t.DB.prepare("DELETE FROM users WHERE id = 'user-1'").run();

    expect(await getSessionUser(t.db, token)).toBeNull();
    expect(await filas()).toEqual([]);
  });

  it("S6: deleteSession borra solo la fila de ese token", async () => {
    const a = await createSession(t.db, "user-1");
    const b = await createSession(t.db, "user-1");

    await deleteSession(t.db, a);

    expect(await getSessionUser(t.db, a)).toBeNull();
    expect(await getSessionUser(t.db, b)).not.toBeNull();
  });

  it("S7: deleteUserSessions borra todas las del usuario y ninguna de otro", async () => {
    await createSession(t.db, "user-1");
    await createSession(t.db, "user-1");
    const ajena = await createSession(t.db, "user-2");

    await deleteUserSessions(t.db, "user-1");

    const restantes = await filas();
    expect(restantes).toHaveLength(1);
    expect(restantes[0].id).toBe(await hashToken(ajena));
  });

  it("S14: dos dispositivos del mismo usuario son dos filas y el logout de una no invalida la otra", async () => {
    const movil = await createSession(t.db, "user-1");
    const escritorio = await createSession(t.db, "user-1");
    expect(await filas()).toHaveLength(2);

    await deleteSession(t.db, movil);

    expect(await getSessionUser(t.db, escritorio)).not.toBeNull();
  });

  describe("purgeExpiredSessions (S13)", () => {
    const insertar = (id: string, expiresAt: number) =>
      t.DB.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, 'user-1', 0, ?)")
        .bind(id, expiresAt)
        .run();

    it("borra las vencidas, conserva las vigentes y devuelve la cantidad", async () => {
      await insertar("vencida-1", segundos() - 10);
      await insertar("vencida-2", segundos() - 1);
      await insertar("vigente", segundos() + 10);

      expect(await purgeExpiredSessions(t.db)).toBe(2);
      expect((await filas()).map((f) => f.id)).toEqual(["vigente"]);
    });

    it("respeta el tope de filas por corrida", async () => {
      for (let i = 0; i < 5; i++) await insertar(`vencida-${i}`, segundos() - 10);

      expect(await purgeExpiredSessions(t.db, new Date(), 3)).toBe(3);
      expect(await filas()).toHaveLength(2);
    });

    it("no falla sin filas", async () => {
      expect(await purgeExpiredSessions(t.db)).toBe(0);
    });
  });

  it("S18: countSessions separa vigentes y vencidas", async () => {
    expect(await countSessions(t.db)).toEqual({ vigentes: 0, vencidas: 0 });

    await createSession(t.db, "user-1");
    await createSession(t.db, "user-1");
    await createSession(t.db, "user-1", new Date(ahora.getTime() - 31 * DIA * 1000));

    expect(await countSessions(t.db)).toEqual({ vigentes: 2, vencidas: 1 });
  });

  it("S15: la tabla existe vacía tras las migraciones y no toca users", async () => {
    const { results } = await t.DB.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'sessions%' ORDER BY name").all<{ name: string }>();
    expect(results.map((r) => r.name)).toEqual(["sessions", "sessions_expires_at_idx", "sessions_user_id_idx"]);
    expect((await t.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())!.n).toBeGreaterThan(0);
  });
});
