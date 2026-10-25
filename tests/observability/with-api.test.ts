import { describe, expect, it } from "vitest";
import { withApi } from "../../src/lib/observability/with-api";
import { createLogger } from "../../src/lib/observability/logger";
import { apiCtx } from "../helpers/ctx";

const ctx = (over: Record<string, unknown> = {}, headers: Record<string, string> = {}) => apiCtx({ over, headers });

function capturar() {
  const lineas: { level: string; data: Record<string, any> }[] = [];
  const logger = createLogger({ write: (level, line) => lineas.push({ level, data: JSON.parse(line) }) });
  return { logger, lineas };
}

describe("withApi", () => {
  it("devuelve la respuesta del handler sin alterar status ni cuerpo", async () => {
    const { logger } = capturar();
    const res = await withApi(async () => Response.json({ ok: true }, { status: 201 }), { logger })(ctx());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("agrega x-request-id a la respuesta y lo deja en locals", async () => {
    const { logger } = capturar();
    const c = ctx();
    const res = await withApi(async () => new Response("x"), { logger })(c);
    const id = res.headers.get("x-request-id");
    expect(id).toBeTruthy();
    expect(c.locals.requestId).toBe(id);
  });

  it("reutiliza cf-ray como requestId si viene en el request", async () => {
    const { logger } = capturar();
    const res = await withApi(async () => new Response("x"), { logger })(ctx({}, { "cf-ray": "abc123-EZE" }));
    expect(res.headers.get("x-request-id")).toBe("abc123-EZE");
  });

  it("funciona con respuestas de headers inmutables (redirects)", async () => {
    const { logger } = capturar();
    const res = await withApi(async () => Response.redirect("https://fisture.test/login", 302), { logger })(ctx());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://fisture.test/login");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("loguea un evento request con método, ruta, status, duración y usuario", async () => {
    const { logger, lineas } = capturar();
    const c = ctx();
    c.locals.user = { id: "u1" };
    await withApi(async () => new Response("x"), { logger })(c);
    expect(lineas).toHaveLength(1);
    expect(lineas[0].level).toBe("info");
    expect(lineas[0].data).toMatchObject({
      msg: "request",
      method: "GET",
      path: "/api/partidos",
      status: 200,
      userId: "u1",
    });
    expect(typeof lineas[0].data.durationMs).toBe("number");
    expect(lineas[0].data.requestId).toBeTruthy();
  });

  it("usa routePattern como route cuando existe (evita alta cardinalidad)", async () => {
    const { logger, lineas } = capturar();
    await withApi(async () => new Response("x"), { logger })(ctx({ routePattern: "/api/equipos/[id]" }));
    expect(lineas[0].data.route).toBe("/api/equipos/[id]");
  });

  it("4xx se loguea como warn y 5xx como error", async () => {
    const { logger, lineas } = capturar();
    await withApi(async () => new Response("no", { status: 401 }), { logger })(ctx());
    await withApi(async () => new Response("mal", { status: 503 }), { logger })(ctx());
    expect(lineas.map((l) => l.level)).toEqual(["warn", "error"]);
  });

  it("una excepción devuelve 500 JSON uniforme sin filtrar el mensaje interno", async () => {
    const { logger } = capturar();
    const res = await withApi(
      async () => {
        throw new Error("password de la base: hunter2");
      },
      { logger }
    )(ctx());
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = await res.json();
    expect(body).toEqual({ error: "Internal error", requestId: res.headers.get("x-request-id") });
    expect(JSON.stringify(body)).not.toContain("hunter2");
  });

  it("una excepción se loguea como error con stack y contexto", async () => {
    const { logger, lineas } = capturar();
    await withApi(
      async () => {
        throw new Error("boom");
      },
      { logger }
    )(ctx());
    expect(lineas).toHaveLength(1);
    expect(lineas[0].level).toBe("error");
    expect(lineas[0].data).toMatchObject({ msg: "request", status: 500, path: "/api/partidos" });
    expect(lineas[0].data.err.message).toBe("boom");
    expect(lineas[0].data.err.stack).toContain("boom");
  });

  it("expone un logger con el requestId en locals para los handlers", async () => {
    const { logger, lineas } = capturar();
    await withApi(
      async ({ locals }) => {
        (locals as any).logger.info("dentro del handler");
        return new Response("x");
      },
      { logger }
    )(ctx());
    const dentro = lineas.find((l) => l.data.msg === "dentro del handler");
    expect(dentro?.data.requestId).toBeTruthy();
  });
});
