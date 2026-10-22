import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger, defaultLevel, redact, serializeError } from "../../src/lib/observability/logger";

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
});
