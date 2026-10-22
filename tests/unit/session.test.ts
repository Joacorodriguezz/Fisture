import { expect, it, vi } from "vitest";
import { createSession, deleteSession, getSession } from "../../src/lib/auth/session";

it("guarda sesiones con TTL, las consulta y las elimina", async () => {
  const values = new Map<string, string>();
  const put = vi.fn(async (key: string, value: string) => { values.set(key, value); });
  const kv = { put, get: async (key: string) => values.get(key) ?? null, delete: async (key: string) => { values.delete(key); } } as unknown as KVNamespace;
  const id = await createSession(kv, "user-1");
  expect(id).toMatch(/^[a-z0-9]{32}$/);
  expect(put).toHaveBeenCalledWith(`session:${id}`, "user-1", { expirationTtl: 2_592_000 });
  expect(await getSession(kv, id)).toBe("user-1");
  expect(await getSession(kv, "expired")).toBeNull();
  await deleteSession(kv, id);
  expect(await getSession(kv, id)).toBeNull();
});
