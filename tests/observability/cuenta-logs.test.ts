// C12: los logs del borrado de cuenta no contienen email, nombre, userId ni tokens (D9).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../helpers/use-test-db";
import { seedApp } from "../helpers/fixtures";
import { apiCtx, kvEnMemoria } from "../helpers/ctx";
import { users } from "../../drizzle/schema";

const { revocar } = vi.hoisted(() => ({ revocar: vi.fn() }));
vi.mock("../../src/lib/auth/providers", () => ({
  createGoogleProvider: () => ({ revokeToken: revocar }),
  createMicrosoftProvider: () => ({}),
}));

import { DELETE } from "../../src/pages/api/cuenta";

describe("logs de DELETE /api/cuenta", () => {
  const t = useTestDb();
  let lineas: string[];

  beforeEach(() => {
    lineas = [];
    for (const metodo of ["log", "warn", "error"] as const) {
      vi.spyOn(console, metodo).mockImplementation((l: unknown) => void lineas.push(String(l)));
    }
  });

  const borrar = async (kvFalla = false) => {
    const { user } = await seedApp(t.db);
    await t.db.update(users).set({ refreshToken: "rt-secreto" }).where(eq(users.id, user.id));
    const completo = (await t.db.query.users.findFirst({ where: eq(users.id, user.id) }))!;
    const kv = kvEnMemoria();
    if (kvFalla) kv.delete = async () => { throw new Error("KV caído"); };
    return DELETE(
      apiCtx({
        url: "https://fisture.test/api/cuenta",
        method: "DELETE",
        user: completo,
        body: { confirmar: completo.email },
        env: { ENVIRONMENT: "production", DB: t.DB, KV: kv, PUBLIC_APP_URL: "https://fisture.test" },
        over: { cookies: { get: () => ({ value: "sid" }), delete: vi.fn() } },
      })
    );
  };

  const sinDatosPersonales = () => {
    const todo = lineas.join("\n");
    for (const dato of ["ana@example.test", "Ana", "user-1", "rt-secreto", "test-token"]) {
      expect(todo, dato).not.toContain(dato);
    }
  };

  it("el borrado exitoso registra account_deleted con provider y filas, sin datos personales", async () => {
    revocar.mockResolvedValue(undefined);
    expect((await borrar()).status).toBe(200);

    const registros = lineas.map((l) => JSON.parse(l));
    const evento = registros.find((r) => r.msg === "account_deleted");
    expect(evento).toMatchObject({ provider: "google", rows: { users: 1, userTeams: 0, userPreferences: 0, calendarSyncs: 0 } });
    expect(registros.find((r) => r.msg === "request")).toBeDefined();
    sinDatosPersonales();
  });

  it("si falla la revocación, el warning tampoco incluye el token ni datos personales", async () => {
    revocar.mockRejectedValue(Object.assign(new Error("fallo con rt-secreto ana@example.test"), { status: 503 }));
    expect((await borrar()).status).toBe(200);

    const aviso = lineas.map((l) => JSON.parse(l)).find((r) => r.msg === "account_revoke_failed");
    expect(aviso).toMatchObject({ provider: "google", status: 503 });
    sinDatosPersonales();
  });

  it("si algo lanza después del DELETE, el 500 tampoco loguea el userId", async () => {
    revocar.mockResolvedValue(undefined);
    expect((await borrar(true)).status).toBe(500);

    const registros = lineas.map((l) => JSON.parse(l));
    expect(registros.find((r) => r.msg === "request")).toMatchObject({ status: 500 });
    expect(registros.some((r) => "userId" in r)).toBe(false);
    sinDatosPersonales();
  });
});
