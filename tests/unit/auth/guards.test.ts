import { describe, expect, it } from "vitest";
import { contentTypeValido, decidirAcceso, esMismoOrigen, loginHref, safeNext } from "../../../src/lib/auth/guards";

describe("decidirAcceso: navegación sin sesión", () => {
  const paginasPublicas = [
    "/",
    "/login",
    "/hoy",
    "/ligas",
    "/ligas/abc",
    "/equipos/buscar",
    "/equipos/123",
    "/partidos",
    "/partidos/9",
    "/calendario",
    "/privacidad",
    "/terminos",
  ];
  it.each(paginasPublicas)("permite %s sin sesión", (ruta) => {
    expect(decidirAcceso(ruta, false)).toBe("permitir");
  });

  it("/cuenta pide login sin sesión (y deja pasar con sesión)", () => {
    expect(decidirAcceso("/cuenta", false)).toBe("login");
    expect(decidirAcceso("/cuenta", true)).toBe("permitir");
  });

  it("/configuracion no pide login: la página redirige a /cuenta, que sí lo pide (docs/31 D3)", () => {
    expect(decidirAcceso("/configuracion", false)).toBe("permitir");
  });

  it.each(["/api/equipos", "/api/equipos/42", "/api/partidos", "/api/preferencias", "/api/calendario/sync", "/api/calendario/download"])(
    "API personal %s responde 401 sin sesión y permite con sesión",
    (ruta) => {
      expect(decidirAcceso(ruta, false)).toBe("no_autorizado");
      expect(decidirAcceso(ruta, true)).toBe("permitir");
    }
  );

  it.each(["/api/health", "/api/auth/login/google", "/api/auth/callback/google", "/api/admin/status", "/api/equipos/buscar"])(
    "API pública o con auth propia %s no se bloquea sin sesión",
    (ruta) => {
      expect(decidirAcceso(ruta, false)).toBe("permitir");
    }
  );

  it("no confunde prefijos parecidos", () => {
    expect(decidirAcceso("/api/healthcheck", false)).toBe("no_autorizado");
    expect(decidirAcceso("/cuentax", false)).toBe("permitir");
  });
});

describe("safeNext", () => {
  it("acepta rutas internas con query", () => {
    expect(safeNext("/hoy?fecha=2026-10-21&solo=mios")).toBe("/hoy?fecha=2026-10-21&solo=mios");
    expect(safeNext("/equipos/12")).toBe("/equipos/12");
  });

  it("rechaza vacíos y rutas no relativas", () => {
    expect(safeNext(null)).toBeNull();
    expect(safeNext(undefined)).toBeNull();
    expect(safeNext("")).toBeNull();
    expect(safeNext("hoy")).toBeNull();
  });

  it("rechaza open redirects", () => {
    for (const malo of [
      "https://evil.com",
      "http://evil.com/hoy",
      "//evil.com",
      "///evil.com",
      "/\\evil.com",
      "/\\/evil.com",
      "javascript:alert(1)",
      "/%0d%0aSet-Cookie:x=1".replace("%0d%0a", "\r\n"),
      "/ok\tpath",
    ]) {
      expect(safeNext(malo), malo).toBeNull();
    }
  });

  it("no vuelve a /login ni a la API", () => {
    expect(safeNext("/login")).toBeNull();
    expect(safeNext("/login?next=/hoy")).toBeNull();
    expect(safeNext("/api/auth/logout")).toBeNull();
  });

  it("rechaza destinos demasiado largos", () => {
    expect(safeNext("/" + "a".repeat(600))).toBeNull();
  });
});

describe("esMismoOrigen", () => {
  const env = { PUBLIC_APP_URL: "https://fisture.test" };
  const req = (origin?: string) => new Request("https://fisture.test/api/cuenta", { method: "DELETE", headers: origin ? { Origin: origin } : {} });

  it("acepta el Origin de la app", () => {
    expect(esMismoOrigen(req("https://fisture.test"), env)).toBe(true);
  });

  it("acepta una request sin Origin (no es de navegador cross-site)", () => {
    expect(esMismoOrigen(req(), env)).toBe(true);
  });

  it("tolera una barra final en PUBLIC_APP_URL", () => {
    expect(esMismoOrigen(req("https://fisture.test"), { PUBLIC_APP_URL: "https://fisture.test/" })).toBe(true);
  });

  it("rechaza otro sitio, otro puerto, otro esquema, subdominios y 'null'", () => {
    for (const origen of ["https://evil.com", "https://fisture.test:8443", "http://fisture.test", "https://x.fisture.test", "https://fisture.test.evil.com", "null"]) {
      expect(esMismoOrigen(req(origen), env), origen).toBe(false);
    }
  });

  it("si PUBLIC_APP_URL no es una URL válida, un Origin presente se rechaza", () => {
    expect(esMismoOrigen(req("https://fisture.test"), { PUBLIC_APP_URL: "" })).toBe(false);
  });
});

describe("esMismoOrigen con Sec-Fetch-Site, cookie y ALLOWED_ORIGINS (docs/16 D6)", () => {
  const env = { PUBLIC_APP_URL: "https://fisture.test" };
  const mut = (headers: Record<string, string> = {}, url = "https://fisture.test/api/equipos") =>
    new Request(url, { method: "POST", headers });
  const conCookie = { cookie: "session=abc; otra=1" };

  it("OR1: cookie con Sec-Fetch-Site same-origin o none pasa", () => {
    expect(esMismoOrigen(mut({ ...conCookie, "sec-fetch-site": "same-origin" }), env)).toBe(true);
    expect(esMismoOrigen(mut({ ...conCookie, "sec-fetch-site": "none" }), env)).toBe(true);
  });

  it("OR2/OR3: cross-site y same-site se rechazan", () => {
    expect(esMismoOrigen(mut({ ...conCookie, "sec-fetch-site": "cross-site" }), env)).toBe(false);
    expect(esMismoOrigen(mut({ ...conCookie, "sec-fetch-site": "same-site" }), env)).toBe(false);
  });

  it("OR4/OR5: sin Sec-Fetch-Site decide el Origin", () => {
    expect(esMismoOrigen(mut({ ...conCookie, origin: "https://fisture.test" }), env)).toBe(true);
    expect(esMismoOrigen(mut({ ...conCookie, origin: "https://evil.com" }), env)).toBe(false);
  });

  it("OR6: con cookie de sesión y sin ninguna de las dos cabeceras se rechaza", () => {
    expect(esMismoOrigen(mut(conCookie), env)).toBe(false);
  });

  it("OR7: sin cookie y sin cabeceras (Bearer del cron) pasa", () => {
    expect(esMismoOrigen(mut({ authorization: "Bearer x" }), env)).toBe(true);
  });

  it("una cookie que no es la de sesión no activa la regla", () => {
    expect(esMismoOrigen(mut({ cookie: "tema=oscuro" }), env)).toBe(true);
  });

  it("OR13: ALLOWED_ORIGINS admite otros orígenes (lista separada por comas)", () => {
    const e = { ...env, ALLOWED_ORIGINS: "https://www.fisture.test, https://alias.fisture.pages.dev/" };
    expect(esMismoOrigen(mut({ ...conCookie, origin: "https://www.fisture.test" }), e)).toBe(true);
    expect(esMismoOrigen(mut({ ...conCookie, origin: "https://alias.fisture.pages.dev" }), e)).toBe(true);
    expect(esMismoOrigen(mut({ ...conCookie, origin: "https://otro.com" }), e)).toBe(false);
  });
});

describe("contentTypeValido", () => {
  const post = (headers: Record<string, string>) => new Request("https://fisture.test/api/x", { method: "POST", headers });

  it("OR11: application/json con o sin charset pasa", () => {
    expect(contentTypeValido(post({ "content-type": "application/json" }))).toBe(true);
    expect(contentTypeValido(post({ "content-type": "application/json; charset=utf-8" }))).toBe(true);
    expect(contentTypeValido(post({ "content-type": "Application/JSON" }))).toBe(true);
  });

  it("OR10: text/plain y formularios se rechazan", () => {
    expect(contentTypeValido(post({ "content-type": "text/plain;charset=UTF-8" }))).toBe(false);
    expect(contentTypeValido(post({ "content-type": "application/x-www-form-urlencoded" }))).toBe(false);
    expect(contentTypeValido(post({ "content-type": "application/jsonp" }))).toBe(false);
  });

  it("OR12: sin cuerpo y sin Content-Type pasa; con cuerpo y sin tipo, no", () => {
    expect(contentTypeValido(post({}))).toBe(true);
    expect(contentTypeValido(post({ "content-length": "0" }))).toBe(true);
    expect(contentTypeValido(post({ "content-length": "12" }))).toBe(false);
  });

  it("OR12b: cuerpo sin Content-Type ni Content-Length (chunked) se rechaza", () => {
    const cuerpo = new ReadableStream({
      start: (c) => {
        c.enqueue(new TextEncoder().encode("a=1"));
        c.close();
      },
    });
    const chunked = new Request("https://fisture.test/api/x", { method: "POST", body: cuerpo, duplex: "half" } as RequestInit);
    expect(chunked.headers.get("content-type")).toBeNull();
    expect(chunked.headers.get("content-length")).toBeNull();
    expect(contentTypeValido(chunked)).toBe(false);
  });
});

describe("loginHref", () => {
  it("agrega next codificado cuando es seguro", () => {
    expect(loginHref("/hoy?fecha=2026-10-21")).toBe("/login?next=" + encodeURIComponent("/hoy?fecha=2026-10-21"));
  });

  it("cae a /login simple si next es inseguro o falta", () => {
    expect(loginHref()).toBe("/login");
    expect(loginHref("//evil.com")).toBe("/login");
    expect(loginHref("/login")).toBe("/login");
  });
});
