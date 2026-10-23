import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiCtx, kvEnMemoria, silenciarConsola } from "../../helpers/ctx";
import { createSession, deleteSession, getSession } from "../../../src/lib/auth/session";
import { GET as logout } from "../../../src/pages/api/auth/logout";

describe("sesiones en KV", () => {
  let kv: ReturnType<typeof kvEnMemoria>;
  beforeEach(() => {
    kv = kvEnMemoria();
  });

  it("createSession guarda el usuario con 30 días de vida", async () => {
    const put = vi.spyOn(kv, "put");
    const id = await createSession(kv as any, "u1");
    expect(put).toHaveBeenCalledWith(`session:${id}`, "u1", { expirationTtl: 2_592_000 });
  });

  it("el id de sesión tiene al menos 43 caracteres base64url", async () => {
    const id = await createSession(kv as any, "u1");
    expect(id.length).toBeGreaterThanOrEqual(43);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("1000 ids de sesión generados son todos distintos", async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(await createSession(kv as any, "u1"));
    }
    expect(ids.size).toBe(1000);
  });

  describe("aleatoriedad criptográfica", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("createSession no usa Math.random y sí usa crypto.getRandomValues", async () => {
      const mathRandom = vi.spyOn(Math, "random");
      const getRandomValues = vi.spyOn(crypto, "getRandomValues");
      await createSession(kv as any, "u1");
      expect(mathRandom).not.toHaveBeenCalled();
      expect(getRandomValues).toHaveBeenCalled();
    });

    it("el id es base64url sin relleno aunque los bytes den + y /", async () => {
      // 0xFB 0xFF produce '+' y '/' en base64 estándar: el id debe usar '-' y '_'.
      vi.spyOn(crypto, "getRandomValues").mockImplementation(((arr: Uint8Array) => {
        for (let i = 0; i < arr.length; i++) arr[i] = i % 2 === 0 ? 0xfb : 0xff;
        return arr;
      }) as any);
      const id = await createSession(kv as any, "u1");
      expect(id).toHaveLength(43);
      expect(id).toMatch(/[-_]/);
      expect(id).not.toMatch(/[+/=]/);
    });
  });

  it("getSession devuelve el usuario y null si no existe", async () => {
    const id = await createSession(kv as any, "u1");
    expect(await getSession(kv as any, id)).toBe("u1");
    expect(await getSession(kv as any, "inexistente")).toBeNull();
  });

  it("deleteSession invalida la sesión", async () => {
    const id = await createSession(kv as any, "u1");
    await deleteSession(kv as any, id);
    expect(await getSession(kv as any, id)).toBeNull();
  });

  it("sesiones con id viejo de 32 caracteres siguen válidas y se borran", async () => {
    const viejo = "a".repeat(32);
    await kv.put(`session:${viejo}`, "u1");
    expect(await getSession(kv as any, viejo)).toBe("u1");
    await deleteSession(kv as any, viejo);
    expect(await getSession(kv as any, viejo)).toBeNull();
  });
});

describe("GET /api/auth/logout", () => {
  let kv: ReturnType<typeof kvEnMemoria>;
  const llamar = (cookie?: string) => {
    const cookies = { get: () => (cookie ? { value: cookie } : undefined), delete: vi.fn() };
    const res = logout(
      apiCtx({
        url: "https://fisture.test/api/auth/logout",
        env: { KV: kv },
        over: { cookies, redirect: (d: string) => new Response(null, { status: 302, headers: { Location: d } }) },
      })
    );
    return { res, cookies };
  };

  beforeEach(() => {
    silenciarConsola(vi);
    kv = kvEnMemoria();
  });

  it("borra la sesión de KV, la cookie y redirige a /", async () => {
    const id = await createSession(kv as any, "u1");
    const { res, cookies } = llamar(id);

    expect((await res).headers.get("Location")).toBe("/");
    expect(await getSession(kv as any, id)).toBeNull();
    expect(cookies.delete).toHaveBeenCalledWith("session", { path: "/" });
  });

  it("logout borra una sesión con id viejo de 32 caracteres", async () => {
    const viejo = "a".repeat(32);
    await kv.put(`session:${viejo}`, "u1");
    const { res } = llamar(viejo);
    expect((await res).headers.get("Location")).toBe("/");
    expect(await getSession(kv as any, viejo)).toBeNull();
  });

  it("sin cookie igual redirige a / y no toca KV", async () => {
    const del = vi.spyOn(kv, "delete");
    const { res } = llamar();
    expect((await res).headers.get("Location")).toBe("/");
    expect(del).not.toHaveBeenCalled();
  });
});
