import { afterEach, describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { createLogger, defaultLevel, errorSeguro, mensajeDeError, redact, serializeError } from "../../src/lib/observability/logger";

function capturar(opts: Parameters<typeof createLogger>[0] = {}) {
  const lineas: { level: string; data: Record<string, unknown> }[] = [];
  const logger = createLogger({
    now: () => new Date("2026-10-16T12:00:00.000Z"),
    write: (level, line) => lineas.push({ level, data: JSON.parse(line) }),
    ...opts,
  });
  return { logger, lineas };
}

describe("logger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("emite una línea JSON con ts, level, msg y los campos", () => {
    const { logger, lineas } = capturar();
    logger.info("hola", { userId: "u1", n: 2 });
    expect(lineas).toEqual([
      {
        level: "info",
        data: { userId: "u1", n: 2, ts: "2026-10-16T12:00:00.000Z", level: "info", msg: "hola" },
      },
    ]);
  });

  it("los campos reservados no se pueden pisar desde fields", () => {
    const { logger, lineas } = capturar();
    logger.info("real", { msg: "falso", level: "debug", ts: "ayer" });
    expect(lineas[0].data).toMatchObject({ msg: "real", level: "info", ts: "2026-10-16T12:00:00.000Z" });
  });

  it("incluye env cuando se configura", () => {
    const { logger, lineas } = capturar({ env: "production" });
    logger.info("x");
    expect(lineas[0].data.env).toBe("production");
  });

  it("respeta el nivel mínimo", () => {
    const { logger, lineas } = capturar({ level: "warn" });
    logger.debug("a");
    logger.info("b");
    logger.warn("c");
    logger.error("d");
    expect(lineas.map((l) => l.data.msg)).toEqual(["c", "d"]);
  });

  it("child hereda el contexto y lo puede ampliar sin afectar al padre", () => {
    const { logger, lineas } = capturar({ context: { app: "fisture" } });
    const hijo = logger.child({ requestId: "r1" });
    hijo.info("dentro");
    logger.info("fuera");
    expect(lineas[0].data).toMatchObject({ app: "fisture", requestId: "r1" });
    expect(lineas[1].data.requestId).toBeUndefined();
  });

  it("serializa los Error con name, message y stack", () => {
    const { logger, lineas } = capturar();
    logger.error("falló", { err: new TypeError("boom") });
    const err = lineas[0].data.err as Record<string, string>;
    expect(err.name).toBe("TypeError");
    expect(err.message).toBe("boom");
    expect(err.stack).toContain("boom");
  });

  it("redacta claves sensibles, también anidadas y en arrays", () => {
    const { logger, lineas } = capturar();
    logger.info("x", {
      authorization: "Bearer abc",
      headers: { Cookie: "session=1", ok: "visible" },
      lista: [{ access_token: "t" }, { refresh_token: "r" }],
      client_secret: "s",
      password: "p",
      apiKey: "k",
    });
    const d = lineas[0].data as any;
    expect(d.authorization).toBe("[REDACTED]");
    expect(d.headers.Cookie).toBe("[REDACTED]");
    expect(d.headers.ok).toBe("visible");
    expect(d.lista[0].access_token).toBe("[REDACTED]");
    expect(d.lista[1].refresh_token).toBe("[REDACTED]");
    expect(d.client_secret).toBe("[REDACTED]");
    expect(d.password).toBe("[REDACTED]");
    expect(d.apiKey).toBe("[REDACTED]");
  });

  it("no revienta con referencias circulares", () => {
    const { logger, lineas } = capturar();
    const a: Record<string, unknown> = { nombre: "a" };
    a.self = a;
    logger.info("circular", { a });
    expect((lineas[0].data.a as any).self).toBe("[Circular]");
  });

  it("usa console.warn / console.error según el nivel cuando no hay write", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const logger = createLogger({ level: "debug" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(log).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("defaultLevel", () => {
  it("info en producción y debug en el resto", () => {
    expect(defaultLevel("production")).toBe("info");
    expect(defaultLevel("development")).toBe("debug");
    expect(defaultLevel(undefined)).toBe("info");
  });
});

describe("redact / serializeError", () => {
  it("redact deja pasar primitivos", () => {
    expect(redact(5)).toBe(5);
    expect(redact("a")).toBe("a");
    expect(redact(null)).toBeNull();
  });

  it("serializeError conserva la causa", () => {
    const e = new Error("externo", { cause: new Error("interno") });
    expect((serializeError(e).cause as any).message).toBe("interno");
  });

  // drizzle-orm >= 0.44: el mensaje y el stack de DrizzleQueryError traen los parámetros de la consulta
  it("serializeError de un DrizzleQueryError conserva el SQL y la causa pero no los parámetros", () => {
    const e = new DrizzleQueryError(
      'update "users" set "access_token" = ? where "users"."id" = ?',
      ["ya29.secreto", "u1"],
      new Error("D1_ERROR: falla")
    );
    const s = serializeError(e);
    expect(JSON.stringify(s)).not.toContain("ya29.secreto");
    expect(s).toMatchObject({
      message: 'Failed query: update "users" set "access_token" = ? where "users"."id" = ?',
      query: 'update "users" set "access_token" = ? where "users"."id" = ?',
      cause: { message: "D1_ERROR: falla" },
    });
    expect(s.stack).toContain("Failed query");
  });
});

describe("mensajeDeError", () => {
  it("de un DrizzleQueryError devuelve el mensaje de la causa (el error de D1), sin SQL ni parámetros", () => {
    const e = new DrizzleQueryError("select ?", ["secreto"], new Error("D1_ERROR: no such table: x"));
    expect(mensajeDeError(e)).toBe("D1_ERROR: no such table: x");
  });

  it("de un DrizzleQueryError sin causa devuelve un mensaje genérico", () => {
    expect(mensajeDeError(new DrizzleQueryError("select ?", ["secreto"]))).toBe("Falló una consulta a la base de datos");
  });

  it("de un Error devuelve su mensaje, y de otra cosa el fallback o su texto", () => {
    expect(mensajeDeError(new Error("boom"))).toBe("boom");
    expect(mensajeDeError("texto")).toBe("texto");
    expect(mensajeDeError(undefined, "Error desconocido")).toBe("Error desconocido");
  });
});

describe("errorSeguro (caminos con tokens)", () => {
  it("serializeError conserva el mensaje y el stack: por eso los caminos con tokens no lo usan", () => {
    expect(JSON.stringify(serializeError(new Error("falló con rt-secreto")))).toContain("rt-secreto");
  });

  it("deja solo nombre, código OAuth y status; no el mensaje, el stack ni la causa", () => {
    const error = Object.assign(new Error("falló con rt-secreto", { cause: new Error("ya29.otro") }), { code: "invalid_grant", status: 400 });
    const { logger, lineas } = capturar();
    logger.error("x", { err: errorSeguro(error) });
    expect(lineas[0].data.err).toEqual({ name: "Error", code: "invalid_grant", status: 400 });
    expect(JSON.stringify(lineas)).not.toContain("secreto");
    expect(JSON.stringify(lineas)).not.toContain("ya29");
  });

  it("conserva el mensaje de los errores propios con código fijo y descarta un código con forma de token", () => {
    expect(errorSeguro(new Error("profile_fetch_failed: 403"))).toMatchObject({ message: "profile_fetch_failed: 403" });
    expect(errorSeguro(Object.assign(new Error("x"), { code: "ya29.A0Af-secreto" }))).toEqual({ name: "Error" });
    expect(errorSeguro("cadena con rt-secreto")).toEqual({ name: "NonError" });
  });
});
