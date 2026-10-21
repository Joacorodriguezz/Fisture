import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/d1";
import { seedApp } from "../helpers/fixtures";
import { createDb, type Database } from "../../src/lib/db";
import { getValidAccessToken } from "../../src/lib/auth/tokens";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../src/lib/auth/providers", () => ({
  createGoogleProvider: () => ({ refreshAccessToken: refresh }),
  createMicrosoftProvider: () => ({ refreshAccessToken: refresh }),
}));

describe("renovación de permisos de calendario", () => {
  let t: TestDb;
  let db: Database;
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  beforeEach(async () => { t = await createTestDb(); db = createDb(t.DB); fixtures = await seedApp(db); refresh.mockReset(); });
  afterEach(async () => { await t?.dispose(); });

  it("reutiliza un token vigente sin llamar al proveedor", async () => {
    expect(await getValidAccessToken({} as Env, db, fixtures.user)).toBe("test-token");
    expect(refresh).not.toHaveBeenCalled();
  });
  it.each(["google", "microsoft"])("renueva el token vencido de %s y persiste la nueva expiración", async (provider) => {
    const user = { ...(provider === "google" ? fixtures.user : fixtures.other), tokenExpiresAt: Date.now() - 1000, refreshToken: "original-refresh" };
    const expires = new Date(Date.now() + 3_600_000);
    refresh.mockResolvedValue({ accessToken: () => "new-access", accessTokenExpiresAt: () => expires, refreshToken: () => "new-refresh" });
    expect(await getValidAccessToken({} as Env, db, user)).toBe("new-access");
    expect(await db.query.users.findFirst({ where: (users, { eq }) => eq(users.id, user.id) })).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", tokenExpiresAt: expires.getTime() });
  });
  it("conserva el refresh token cuando Google no entrega otro", async () => {
    refresh.mockResolvedValue({ accessToken: () => "new", accessTokenExpiresAt: () => null, refreshToken: () => { throw new Error("No refresh token"); } });
    await getValidAccessToken({} as Env, db, { ...fixtures.user, tokenExpiresAt: Date.now() - 1000, refreshToken: "keep-me" });
    expect(await db.query.users.findFirst()).toMatchObject({ accessToken: "new", refreshToken: "keep-me", tokenExpiresAt: null });
  });
  it("rechaza permisos ausentes, vencidos o proveedores no soportados", async () => {
    await expect(getValidAccessToken({} as Env, db, { ...fixtures.user, accessToken: null })).rejects.toThrow("No calendar access token");
    await expect(getValidAccessToken({} as Env, db, { ...fixtures.user, tokenExpiresAt: Date.now() - 1000 })).rejects.toThrow("Calendar permission expired");
    await expect(getValidAccessToken({} as Env, db, { ...fixtures.user, provider: "unknown", tokenExpiresAt: Date.now() - 1000, refreshToken: "r" })).rejects.toThrow("Unsupported provider");
  });
});
