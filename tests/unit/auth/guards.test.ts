import { describe, expect, it } from "vitest";
import { decidirAcceso, esMismoOrigen, loginHref, safeNext } from "../../../src/lib/auth/guards";

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

  it("/configuracion pide login sin sesión (y deja pasar con sesión)", () => {
    expect(decidirAcceso("/configuracion", false)).toBe("login");
    expect(decidirAcceso("/configuracion", true)).toBe("permitir");
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
    expect(decidirAcceso("/configuracionx", false)).toBe("permitir");
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
