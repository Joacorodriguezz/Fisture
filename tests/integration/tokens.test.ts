import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../helpers/use-test-db";
import { AHORA, HORA_MS, relojFijo } from "../helpers/clock";
import { seedApp } from "../helpers/fixtures";
import { getValidAccessToken } from "../../src/lib/auth/tokens";
import { oauthIdentities, users } from "../../drizzle/schema";
import { eq } from "drizzle-orm";
import { claro, ENV_CON_CLAVE } from "../helpers/token-key";
import { encryptToken } from "../../src/lib/auth/token-crypto";

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
  const descifrada = async <T extends { id: string; accessToken: string | null; refreshToken: string | null }>(f: T | undefined) =>
    f && { ...f, accessToken: await claro(f.accessToken, f.id, "access_token"), refreshToken: await claro(f.refreshToken, f.id, "refresh_token") };
  const cruda = (id: string) => t.db.query.users.findFirst({ where: (users, { eq }) => eq(users.id, id) });
  const guardado = async (id: string) => descifrada(await cruda(id));

  it("reutiliza un token vigente sin llamar al proveedor", async () => {
    expect(await getValidAccessToken(ENV_CON_CLAVE, t.db, fixtures.user)).toBe("test-token");
    expect(refresh).not.toHaveBeenCalled();
  });

  describe.each(["google", "microsoft"])("%s", (provider) => {
    it("renueva el token vencido y persiste la nueva expiración", async () => {
      const user = vencido(provider === "google" ? fixtures.user : fixtures.other, { refreshToken: "original-refresh" });
      const expires = new Date(AHORA.getTime() + HORA_MS);
      refresh.mockResolvedValue({ accessToken: () => "new-access", accessTokenExpiresAt: () => expires, refreshToken: () => "new-refresh" });

      expect(await getValidAccessToken(ENV_CON_CLAVE, t.db, user)).toBe("new-access");
      expect(await guardado(user.id)).toMatchObject({ accessToken: "new-access", refreshToken: "new-refresh", tokenExpiresAt: expires.getTime() });
    });
  });

  it("conserva el refresh token cuando Google no entrega otro", async () => {
    refresh.mockResolvedValue({ accessToken: () => "new", accessTokenExpiresAt: () => null, refreshToken: () => { throw new Error("No refresh token"); } });
    await getValidAccessToken(ENV_CON_CLAVE, t.db, vencido(fixtures.user, { refreshToken: "keep-me" }));
    expect(await guardado(fixtures.user.id)).toMatchObject({ accessToken: "new", refreshToken: "keep-me", tokenExpiresAt: null });
  });

  describe("permisos que no se pueden renovar", () => {
    it("sin token de acceso", async () => {
      await expect(getValidAccessToken(ENV_CON_CLAVE, t.db, { ...fixtures.user, accessToken: null })).rejects.toThrow("No calendar access token");
    });

    it("token vencido y sin refresh token", async () => {
      await expect(getValidAccessToken(ENV_CON_CLAVE, t.db, vencido(fixtures.user))).rejects.toThrow("Calendar permission expired");
    });

    it("proveedor no soportado", async () => {
      await expect(getValidAccessToken(ENV_CON_CLAVE, t.db, vencido(fixtures.user, { provider: "unknown", refreshToken: "r" }))).rejects.toThrow("Unsupported provider");
    });
  });

  // docs/15: cifrado en reposo
  describe("cifrado de tokens", () => {
    it("K10: un token vigente cifrado se descifra y se devuelve en claro", async () => {
      const cifrado = await encryptToken(ENV_CON_CLAVE, "at-secreto", "user-1:access_token");
      expect(await getValidAccessToken(ENV_CON_CLAVE, t.db, { ...fixtures.user, accessToken: cifrado })).toBe("at-secreto");
    });

    it("K11: al renovar guarda ambos tokens cifrados y devuelve el nuevo en claro", async () => {
      refresh.mockResolvedValue({ accessToken: () => "new-access", accessTokenExpiresAt: () => null, refreshToken: () => "new-refresh" });
      expect(await getValidAccessToken(ENV_CON_CLAVE, t.db, vencido(fixtures.user, { refreshToken: "viejo" }))).toBe("new-access");
      const fila = await cruda("user-1");
      expect(fila?.accessToken).toMatch(/^enc:v1:/);
      expect(fila?.refreshToken).toMatch(/^enc:v1:/);
      expect(JSON.stringify(fila)).not.toContain("new-access");
      expect(JSON.stringify(fila)).not.toContain("new-refresh");
    });

    it("K11: renueva con un refresh token cifrado y conserva ese valor si el proveedor no manda otro", async () => {
      const refreshCifrado = await encryptToken(ENV_CON_CLAVE, "rt-guardado", "user-1:refresh_token");
      refresh.mockResolvedValue({ accessToken: () => "nuevo", accessTokenExpiresAt: () => null, refreshToken: () => { throw new Error("sin refresh"); } });
      await getValidAccessToken(ENV_CON_CLAVE, t.db, vencido(fixtures.user, { refreshToken: refreshCifrado }));
      expect(refresh).toHaveBeenCalledWith("rt-guardado");
      expect(await guardado("user-1")).toMatchObject({ accessToken: "nuevo", refreshToken: "rt-guardado" });
    });

    it("K12: una fila legada en claro se lee bien y pasa a cifrada al renovar", async () => {
      refresh.mockResolvedValue({ accessToken: () => "nuevo", accessTokenExpiresAt: () => null, refreshToken: () => "rt-nuevo" });
      expect(await getValidAccessToken(ENV_CON_CLAVE, t.db, fixtures.user)).toBe("test-token");
      await getValidAccessToken(ENV_CON_CLAVE, t.db, vencido(fixtures.user, { refreshToken: "legado" }));
      expect((await cruda("user-1"))?.accessToken).toMatch(/^enc:v1:/);
    });

    it("K7: sin la clave renovar lanza y no guarda nada en claro", async () => {
      refresh.mockResolvedValue({ accessToken: () => "nuevo", accessTokenExpiresAt: () => null, refreshToken: () => "rt-nuevo" });
      await t.db.update(users).set({ refreshToken: "legado" }).where(eq(users.id, "user-1"));
      await expect(getValidAccessToken({} as Env, t.db, vencido(fixtures.user, { refreshToken: "legado" }))).rejects.toThrow("token_key_missing");
      expect(await cruda("user-1")).toMatchObject({ accessToken: "test-token", refreshToken: "legado" });
    });

    it("un token cifrado sin la clave no se puede leer", async () => {
      const cifrado = await encryptToken(ENV_CON_CLAVE, "at", "user-1:access_token");
      await expect(getValidAccessToken({} as Env, t.db, { ...fixtures.user, accessToken: cifrado })).rejects.toThrow("token_key_missing");
    });

    it("un valor copiado de otro usuario no se descifra (AAD)", async () => {
      const ajeno = await encryptToken(ENV_CON_CLAVE, "at-ajeno", "user-2:access_token");
      await expect(getValidAccessToken(ENV_CON_CLAVE, t.db, { ...fixtures.user, accessToken: ajeno })).rejects.toThrow();
    });
  });

  // docs/18 D4: los tokens salen de la identidad del proveedor de calendario activo (users.provider)
  describe("tokens por identidad", () => {
    const vence = () => AHORA.getTime() - 1000;
    const identidad = (id: string, userId: string, provider: string, extra: Record<string, unknown> = {}) =>
      t.db.insert(oauthIdentities).values({ id, userId, provider, providerId: `p-${id}`, accessToken: `at-${id}`, refreshToken: `rt-${id}`, tokenExpiresAt: AHORA.getTime() + HORA_MS, ...extra });
    const identidadCruda = (id: string) => t.db.query.oauthIdentities.findFirst({ where: (i, { eq }) => eq(i.id, id) });
    const identidadGuardada = async (id: string) => descifrada(await identidadCruda(id));

    it("V-15: usa el token de la identidad activa y no el de otra vinculada", async () => {
      await identidad("user-1", "user-1", "google", { accessToken: "at-google" });
      await identidad("ms-1", "user-1", "microsoft", { accessToken: "at-microsoft" });
      expect(await getValidAccessToken(ENV_CON_CLAVE, t.db, fixtures.user)).toBe("at-google");
    });

    it("el token de la identidad manda sobre el copiado en users.* (doble escritura)", async () => {
      await identidad("user-1", "user-1", "google", { accessToken: "at-identidad" });
      expect(await getValidAccessToken(ENV_CON_CLAVE, t.db, { ...fixtures.user, accessToken: "at-viejo" })).toBe("at-identidad");
    });

    it("renueva con el refresh token de la identidad, la actualiza y escribe users.*; no toca las demás", async () => {
      await identidad("user-1", "user-1", "google", { tokenExpiresAt: vence(), refreshToken: "rt-google" });
      await identidad("ms-1", "user-1", "microsoft", { tokenExpiresAt: vence() });
      const expira = new Date(AHORA.getTime() + HORA_MS);
      refresh.mockResolvedValue({ accessToken: () => "nuevo", accessTokenExpiresAt: () => expira, refreshToken: () => "rt-nuevo" });

      expect(await getValidAccessToken(ENV_CON_CLAVE, t.db, fixtures.user)).toBe("nuevo");

      expect(refresh).toHaveBeenCalledWith("rt-google");
      expect(await identidadGuardada("user-1")).toMatchObject({ accessToken: "nuevo", refreshToken: "rt-nuevo", tokenExpiresAt: expira.getTime() });
      expect(await guardado("user-1")).toMatchObject({ accessToken: "nuevo", refreshToken: "rt-nuevo" });
      expect(await identidadGuardada("ms-1")).toMatchObject({ accessToken: "at-ms-1", tokenExpiresAt: vence() });
    });

    it("conserva el refresh token de la identidad cuando el proveedor no entrega otro", async () => {
      await identidad("user-1", "user-1", "google", { tokenExpiresAt: vence(), refreshToken: "rt-google" });
      refresh.mockResolvedValue({ accessToken: () => "nuevo", accessTokenExpiresAt: () => null, refreshToken: () => { throw new Error("sin refresh"); } });
      await getValidAccessToken(ENV_CON_CLAVE, t.db, fixtures.user);
      expect(await identidadGuardada("user-1")).toMatchObject({ accessToken: "nuevo", refreshToken: "rt-google" });
    });

    it("sin identidad (usuario legado) cae a users.*", async () => {
      expect(await getValidAccessToken(ENV_CON_CLAVE, t.db, fixtures.user)).toBe("test-token");
    });
  });
});
