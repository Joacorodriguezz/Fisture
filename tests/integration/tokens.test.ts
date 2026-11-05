import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { AHORA, HORA_MS, relojFijo } from "../helpers/clock";
import { ENV_VACIO, seedApp } from "../helpers/fixtures";
import { getValidAccessToken } from "../../src/lib/auth/tokens";
import { oauthIdentities } from "../../drizzle/schema";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("../../src/lib/auth/providers", () => ({
  createGoogleProvider: () => ({ refreshAccessToken: refresh }),
  createMicrosoftProvider: () => ({ refreshAccessToken: refresh }),
}));

describe("renovación de permisos de calendario", () => {
  const t = useTestDb();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;
  relojFijo();
  beforeEach(async () => {
    fixtures = await seedApp(t.db);
    refresh.mockReset();
  });

  const vencido = (user: typeof fixtures.user, extra: Record<string, unknown> = {}) => ({ ...user, tokenExpiresAt: AHORA.getTime() - 1000, ...extra });
  const guardado = (id: string) => t.db.query.users.findFirst({ where: (users, { eq }) => eq(users.id, id) });

  it("reutiliza un token vigente sin llamar al proveedor", async () => {
    expect(await getValidAccessToken(ENV_VACIO, t.db, fixtures.user)).toBe("test-token");
    expect(refresh).not.toHaveBeenCalled();
  });

  describe.each(["google", "microsoft"])("%s", (provider) => {
    it("renueva el token vencido y persiste la nueva expiración", async () => {
      const user = vencido(provider === "google" ? fixtures.user : fixtures.other, { refreshToken: "original-refresh" });
      const expires = new Date(AHORA.getTime() + HORA_MS);
      refresh.mockResolvedValue({ accessToken: () => "new-access", accessTokenExpiresAt: () => expires, refreshToken: () => "new-refresh" });

      expect(await getValidAccessToken(ENV_VACIO, t.db, user)).toBe("new-access");
      expect(await guardado(user.id)).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", tokenExpiresAt: expires.getTime() });
    });
  });

  it("conserva el refresh token cuando Google no entrega otro", async () => {
    refresh.mockResolvedValue({ accessToken: () => "new", accessTokenExpiresAt: () => null, refreshToken: () => { throw new Error("No refresh token"); } });
    await getValidAccessToken(ENV_VACIO, t.db, vencido(fixtures.user, { refreshToken: "keep-me" }));
    expect(await guardado(fixtures.user.id)).toMatchObject({ accessToken: "new", refreshToken: "keep-me", tokenExpiresAt: null });
  });

  describe("permisos que no se pueden renovar", () => {
    it("sin token de acceso", async () => {
      await expect(getValidAccessToken(ENV_VACIO, t.db, { ...fixtures.user, accessToken: null })).rejects.toThrow("No calendar access token");
    });

    it("token vencido y sin refresh token", async () => {
      await expect(getValidAccessToken(ENV_VACIO, t.db, vencido(fixtures.user))).rejects.toThrow("Calendar permission expired");
    });

    it("proveedor no soportado", async () => {
      await expect(getValidAccessToken(ENV_VACIO, t.db, vencido(fixtures.user, { provider: "unknown", refreshToken: "r" }))).rejects.toThrow("Unsupported provider");
    });
  });

  // docs/18 D4: los tokens salen de la identidad del proveedor de calendario activo (users.provider)
  describe("tokens por identidad", () => {
    const vence = () => AHORA.getTime() - 1000;
    const identidad = (id: string, userId: string, provider: string, extra: Record<string, unknown> = {}) =>
      t.db.insert(oauthIdentities).values({ id, userId, provider, providerId: `p-${id}`, accessToken: `at-${id}`, refreshToken: `rt-${id}`, tokenExpiresAt: AHORA.getTime() + HORA_MS, ...extra });
    const identidadGuardada = (id: string) => t.db.query.oauthIdentities.findFirst({ where: (i, { eq }) => eq(i.id, id) });

    it("V-15: usa el token de la identidad activa y no el de otra vinculada", async () => {
      await identidad("user-1", "user-1", "google", { accessToken: "at-google" });
      await identidad("ms-1", "user-1", "microsoft", { accessToken: "at-microsoft" });
      expect(await getValidAccessToken(ENV_VACIO, t.db, fixtures.user)).toBe("at-google");
    });

    it("el token de la identidad manda sobre el copiado en users.* (doble escritura)", async () => {
      await identidad("user-1", "user-1", "google", { accessToken: "at-identidad" });
      expect(await getValidAccessToken(ENV_VACIO, t.db, { ...fixtures.user, accessToken: "at-viejo" })).toBe("at-identidad");
    });

    it("renueva con el refresh token de la identidad, la actualiza y escribe users.*; no toca las demás", async () => {
      await identidad("user-1", "user-1", "google", { tokenExpiresAt: vence(), refreshToken: "rt-google" });
      await identidad("ms-1", "user-1", "microsoft", { tokenExpiresAt: vence() });
      const expira = new Date(AHORA.getTime() + HORA_MS);
      refresh.mockResolvedValue({ accessToken: () => "nuevo", accessTokenExpiresAt: () => expira, refreshToken: () => "rt-nuevo" });

      expect(await getValidAccessToken(ENV_VACIO, t.db, fixtures.user)).toBe("nuevo");

      expect(refresh).toHaveBeenCalledWith("rt-google");
      expect(await identidadGuardada("user-1")).toMatchObject({ accessToken: "nuevo", refreshToken: "rt-nuevo", tokenExpiresAt: expira.getTime() });
      expect(await guardado("user-1")).toMatchObject({ accessToken: "nuevo", refreshToken: "rt-nuevo" });
      expect(await identidadGuardada("ms-1")).toMatchObject({ accessToken: "at-ms-1", tokenExpiresAt: vence() });
    });

    it("conserva el refresh token de la identidad cuando el proveedor no entrega otro", async () => {
      await identidad("user-1", "user-1", "google", { tokenExpiresAt: vence(), refreshToken: "rt-google" });
      refresh.mockResolvedValue({ accessToken: () => "nuevo", accessTokenExpiresAt: () => null, refreshToken: () => { throw new Error("sin refresh"); } });
      await getValidAccessToken(ENV_VACIO, t.db, fixtures.user);
      expect(await identidadGuardada("user-1")).toMatchObject({ accessToken: "nuevo", refreshToken: "rt-google" });
    });

    it("sin identidad (usuario legado) cae a users.*", async () => {
      expect(await getValidAccessToken(ENV_VACIO, t.db, fixtures.user)).toBe("test-token");
    });
  });
});
