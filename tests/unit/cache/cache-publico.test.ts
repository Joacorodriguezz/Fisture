import { describe, expect, it, vi } from "vitest";
import { claveDeCache, politicaDe, servirConCache, type CacheLike, type EntradaCache } from "../../../src/lib/cache-publico";

const BUILD = "build-1";

function cacheFalsa() {
  const mapa = new Map<string, Response>();
  const cache: CacheLike = {
    match: async (req) => mapa.get(typeof req === "string" ? req : req.url)?.clone(),
    put: async (req, res) => {
      mapa.set(typeof req === "string" ? req : req.url, res);
    },
  };
  return { mapa, cache };
}

function entrada(path: string, extra: Partial<EntradaCache> & { headers?: Record<string, string>; method?: string } = {}) {
  const { headers, method, ...resto } = extra;
  const { cache } = cacheFalsa();
  const pendientes: Promise<unknown>[] = [];
  const base: EntradaCache = {
    request: new Request(`https://fisture.test${path}`, { method: method ?? "GET", headers }),
    cache,
    waitUntil: (p) => void pendientes.push(p),
    buildId: BUILD,
    apagado: false,
    ...resto,
  };
  return { base, pendientes };
}

const html = (cuerpo = "<p>hola</p>", init: ResponseInit = {}) =>
  new Response(cuerpo, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" }, ...init });

describe("politicaDe", () => {
  it.each(["/equipos/river", "/ligas/liga-argentina", "/partidos/superclasico"])("%s tiene TTL de 900 s", (p) => {
    expect(politicaDe(p)?.ttl).toBe(900);
  });
  it.each(["/equipos/buscar", "/equipos", "/equipos/", "/hoy", "/", "/api/health", "/equipos/river/otra", "/ligas", "/partidos"])(
    "%s no se cachea",
    (p) => {
      expect(politicaDe(p)).toBeNull();
    }
  );
});

describe("claveDeCache", () => {
  it("incluye el build id y distingue builds", () => {
    const url = new URL("https://fisture.test/equipos/river");
    expect(claveDeCache(url, "a")).toContain("a");
    expect(claveDeCache(url, "a")).not.toBe(claveDeCache(url, "b"));
  });
  it("distingue la query", () => {
    expect(claveDeCache(new URL("https://fisture.test/equipos/river?lado=local"), BUILD)).not.toBe(
      claveDeCache(new URL("https://fisture.test/equipos/river"), BUILD)
    );
  });
});

describe("servirConCache: salteo", () => {
  const casos: [string, string, Parameters<typeof entrada>[1]][] = [
    ["cookie session", "/equipos/river", { headers: { Cookie: "a=1; session=abc" } }],
    ["método POST", "/equipos/river", { method: "POST" }],
    ["query no permitida", "/equipos/river?x=1", {}],
    ["query en ligas", "/ligas/x?lado=local", {}],
    ["interruptor apagado", "/equipos/river", { apagado: true }],
    ["sin caches", "/equipos/river", { cache: undefined }],
    ["ruta fuera de la tabla", "/hoy", {}],
  ];
  it.each(casos)("%s: no lee ni escribe y devuelve el render tal cual", async (_n, path, extra) => {
    const { base, pendientes } = entrada(path, extra);
    const match = vi.fn();
    const put = vi.fn();
    const cache = base.cache ? { match, put } : undefined;
    const next = vi.fn(async () => html());
    const res = await servirConCache({ ...base, cache }, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(match).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(pendientes).toHaveLength(0);
    expect(res.headers.get("x-fisture-cache")).toBeNull();
    expect(await res.text()).toBe("<p>hola</p>");
  });

  it("acepta ?lado= en equipos", async () => {
    const { base } = entrada("/equipos/river?lado=local");
    const res = await servirConCache(base, async () => html());
    expect(res.headers.get("x-fisture-cache")).toBe("MISS");
  });

  it("una cookie session inválida tampoco usa la caché", async () => {
    const { mapa, cache } = cacheFalsa();
    mapa.set(claveDeCache(new URL("https://fisture.test/equipos/river"), BUILD), html("<p>anon</p>"));
    const { base } = entrada("/equipos/river", { cache, headers: { Cookie: "session=basura" } });
    const res = await servirConCache(base, async () => html("<p>render</p>"));
    expect(await res.text()).toBe("<p>render</p>");
  });
});

describe("servirConCache: MISS y HIT", () => {
  it("primer pedido: MISS, guarda una copia con s-maxage=900; segundo: HIT sin llamar a next", async () => {
    const { mapa, cache } = cacheFalsa();
    const pendientes: Promise<unknown>[] = [];
    const base = (): EntradaCache => ({
      request: new Request("https://fisture.test/equipos/river"),
      cache,
      waitUntil: (p) => void pendientes.push(p),
      buildId: BUILD,
      apagado: false,
    });
    const next = vi.fn(async () => html("<p>equipo</p>"));

    const r1 = await servirConCache(base(), next);
    await Promise.all(pendientes);
    expect(r1.headers.get("x-fisture-cache")).toBe("MISS");
    expect(r1.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(await r1.text()).toBe("<p>equipo</p>");
    expect(mapa.size).toBe(1);
    const guardada = [...mapa.values()][0];
    expect(guardada.headers.get("Cache-Control")).toBe("public, s-maxage=900");
    expect(guardada.headers.get("Set-Cookie")).toBeNull();
    expect(guardada.headers.get("x-fisture-cache")).toBeNull();
    expect(await guardada.clone().text()).toBe("<p>equipo</p>");

    const r2 = await servirConCache(base(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(r2.headers.get("x-fisture-cache")).toBe("HIT");
    expect(r2.headers.get("Cache-Control")).toBe("public, max-age=0, must-revalidate");
    expect(r2.headers.get("Content-Type")).toContain("text/html");
    expect(await r2.text()).toBe("<p>equipo</p>");
  });

  it("builds distintos no comparten entradas", async () => {
    const { cache } = cacheFalsa();
    const pendientes: Promise<unknown>[] = [];
    const mk = (buildId: string): EntradaCache => ({
      request: new Request("https://fisture.test/ligas/x"),
      cache,
      waitUntil: (p) => void pendientes.push(p),
      buildId,
      apagado: false,
    });
    const next = vi.fn(async () => html());
    await servirConCache(mk("a"), next);
    await Promise.all(pendientes);
    const r = await servirConCache(mk("b"), next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(r.headers.get("x-fisture-cache")).toBe("MISS");
  });
});

describe("servirConCache: qué no se guarda", () => {
  const casos: [string, () => Response][] = [
    ["404", () => html("no", { status: 404 })],
    ["301", () => new Response(null, { status: 301, headers: { Location: "/equipos/x", "Content-Type": "text/html" } })],
    ["500", () => html("error", { status: 500 })],
    ["Set-Cookie", () => html("x", { headers: { "Content-Type": "text/html", "Set-Cookie": "a=1" } })],
    ["no HTML", () => new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } })],
    ["sin Content-Type", () => new Response("x", { status: 200 })],
  ];
  it.each(casos)("%s", async (_n, respuesta) => {
    const { mapa, cache } = cacheFalsa();
    const pendientes: Promise<unknown>[] = [];
    const original = respuesta();
    const estado = original.status;
    const res = await servirConCache(
      { request: new Request("https://fisture.test/equipos/river"), cache, waitUntil: (p) => void pendientes.push(p), buildId: BUILD, apagado: false },
      async () => original
    );
    await Promise.all(pendientes);
    expect(mapa.size).toBe(0);
    expect(res.status).toBe(estado);
    expect(res.headers.get("x-fisture-cache")).toBeNull();
  });
});

describe("servirConCache: la caché nunca rompe la página", () => {
  it("match que tira: se sirve el render y se avisa", async () => {
    const onError = vi.fn();
    const { base } = entrada("/equipos/river", {
      cache: { match: async () => { throw new Error("boom"); }, put: async () => {} },
      onError,
    });
    const res = await servirConCache(base, async () => html("<p>ok</p>"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<p>ok</p>");
    expect(onError).toHaveBeenCalledWith("match", expect.any(Error));
  });

  it("put que tira (rechazo): se sirve el render y no hay rechazo sin manejar", async () => {
    const onError = vi.fn();
    const pendientes: Promise<unknown>[] = [];
    const { base } = entrada("/equipos/river", {
      cache: { match: async () => undefined, put: async () => { throw new Error("boom"); } },
      waitUntil: (p) => void pendientes.push(p),
      onError,
    });
    const res = await servirConCache(base, async () => html("<p>ok</p>"));
    expect(await res.text()).toBe("<p>ok</p>");
    await expect(Promise.all(pendientes)).resolves.toBeDefined();
    expect(onError).toHaveBeenCalledWith("put", expect.any(Error));
  });

  it("put que tira de forma síncrona: se sirve el render", async () => {
    const { base } = entrada("/equipos/river", {
      cache: { match: async () => undefined, put: () => { throw new Error("sync"); } },
    });
    const res = await servirConCache(base, async () => html("<p>ok</p>"));
    expect(await res.text()).toBe("<p>ok</p>");
  });

  it("si next() tira, el error se propaga (no es de la caché)", async () => {
    const { base } = entrada("/equipos/river");
    await expect(servirConCache(base, async () => { throw new Error("render"); })).rejects.toThrow("render");
  });
});
