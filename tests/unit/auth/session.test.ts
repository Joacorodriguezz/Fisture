import { beforeEach, describe, expect, it, vi } from "vitest";
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

  it("el id de sesión tiene 32 caracteres alfanuméricos en minúscula", async () => {
    expect(await createSession(kv as any, "u1")).toMatch(/^[a-z0-9]{32}$/);
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

  it("sin cookie igual redirige a / y no toca KV", async () => {
    const del = vi.spyOn(kv, "delete");
    const { res } = llamar();
    expect((await res).headers.get("Location")).toBe("/");
    expect(del).not.toHaveBeenCalled();
  });
});
