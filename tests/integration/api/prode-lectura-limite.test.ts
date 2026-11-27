import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTestDb } from "../../helpers/use-test-db";
import { seedApp } from "../../helpers/fixtures";
import { apiCtx, silenciarConsola } from "../../helpers/ctx";
import { relojFijo } from "../../helpers/clock";
import { reiniciarMemoria } from "../../../src/lib/rate-limit/memory";
import { reiniciarConfig } from "../../../src/lib/rate-limit/config";
import { POLICIES } from "../../../src/lib/rate-limit/policies";
import { GET as ranking } from "../../../src/pages/api/prode/ranking";
import { GET as misPuntos } from "../../../src/pages/api/prode/mis-puntos";
import { GET as rankingGrupo } from "../../../src/pages/api/prode/grupos/[id]/ranking";

const APP = "https://fisture.test";

describe("API prode: límite de lectura por usuario", () => {
  const t = useTestDb();
  relojFijo();
  let fixtures: Awaited<ReturnType<typeof seedApp>>;

  beforeEach(async () => {
    silenciarConsola(vi);
    reiniciarMemoria();
    reiniciarConfig();
    fixtures = await seedApp(t.db);
  });

  const peticion = (path: string, user: { id: string }, params?: Record<string, string>) =>
    apiCtx({
      url: `${APP}${path}`,
      method: "GET",
      headers: { "cf-connecting-ip": "203.0.113.7" },
      user,
      params,
      env: { DB: t.DB, ENVIRONMENT: "test", PUBLIC_APP_URL: APP, RATE_LIMIT_SALT: "sal" },
    });

  it("prode_lectura: 60 por minuto por usuario", () => {
    expect(POLICIES.prode_lectura).toEqual({ limit: 60, windowSec: 60, scope: "user" });
  });

  const casos: [string, string, (c: ReturnType<typeof peticion>) => Promise<Response>, Record<string, string>?][] = [
    ["ranking general", "/api/prode/ranking", ranking],
    ["mis puntos", "/api/prode/mis-puntos", misPuntos],
    ["ranking de grupo", "/api/prode/grupos/g1/ranking", rankingGrupo, { id: "g1" }],
  ];

  for (const [nombre, path, handler, params] of casos) {
    it(`${nombre}: la lectura 61 en un minuto da 429, y otro usuario no se ve afectado`, async () => {
      for (let i = 0; i < 60; i++) expect((await handler(peticion(path, fixtures.user, params))).status).not.toBe(429);
      const res = await handler(peticion(path, fixtures.user, params));
      expect(res.status).toBe(429);
      expect(res.headers.get("Retry-After")).toBeTruthy();
      expect((await handler(peticion(path, fixtures.other, params))).status).not.toBe(429);
    });
  }
});
