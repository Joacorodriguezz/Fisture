import { describe, expect, it } from "vitest";
import { hit, peek } from "../../../src/lib/rate-limit/limiter";
import { limpiarRateLimits } from "../../../src/lib/rate-limit/cleanup";
import { metricasRateLimit } from "../../../src/lib/rate-limit/metricas";
import { useTestDb } from "../../helpers/use-test-db";

const T0 = 1_800_000_040_000 - (1_800_000_040_000 % 60_000); // inicio de una ventana de 60 s
const REGLA = { limit: 10, windowSec: 60 };

describe("hit() contra D1", () => {
  const t = useTestDb();

  it("RL1: pasan `limit` requests y la siguiente se bloquea", async () => {
    for (let i = 0; i < 10; i++) expect((await hit(t.DB, "b", "s", REGLA, T0 + i)).allowed).toBe(true);
    const r = await hit(t.DB, "b", "s", REGLA, T0 + 11);
    expect(r.allowed).toBe(false);
    expect(r.count).toBe(11);
  });

  it("RL2: el bloqueo informa el Retry-After de la ventana", async () => {
    for (let i = 0; i < 10; i++) await hit(t.DB, "b", "s", REGLA, T0);
    const r = await hit(t.DB, "b", "s", REGLA, T0 + 23_000);
    expect(r.allowed).toBe(false);
    expect(r.retryAfter).toBe(37);
  });

  it("RL3: la ventana siguiente arranca de cero", async () => {
    for (let i = 0; i < 11; i++) await hit(t.DB, "b", "s", REGLA, T0);
    const r = await hit(t.DB, "b", "s", REGLA, T0 + 60_000);
    expect(r).toMatchObject({ allowed: true, count: 1 });
  });

  it("RL4/RL5: sujetos y buckets distintos tienen contadores independientes", async () => {
    for (let i = 0; i < 11; i++) await hit(t.DB, "b", "usuario-1", REGLA, T0);
    expect((await hit(t.DB, "b", "usuario-2", REGLA, T0)).allowed).toBe(true);
    expect((await hit(t.DB, "otro", "usuario-1", REGLA, T0)).allowed).toBe(true);
  });

  it("RL6: 20 requests concurrentes con límite 10 dejan pasar exactamente 10", async () => {
    const resultados = await Promise.all(Array.from({ length: 20 }, () => hit(t.DB, "c", "s", REGLA, T0)));
    expect(resultados.filter((r) => r.allowed)).toHaveLength(10);
    expect(resultados.filter((r) => !r.allowed)).toHaveLength(10);
  });

  it("RL7: pasado limit x 5 responde bloqueado sin escribir en D1", async () => {
    for (let i = 0; i < 50; i++) await hit(t.DB, "b", "s", REGLA, T0);
    const antes = await t.DB.prepare("SELECT count FROM rate_limits").first<{ count: number }>();
    expect(antes?.count).toBe(50);
    for (let i = 0; i < 5; i++) {
      const r = await hit(t.DB, "b", "s", REGLA, T0 + 1_000);
      expect(r.allowed).toBe(false);
      expect(r.retryAfter).toBeGreaterThanOrEqual(1);
    }
    const despues = await t.DB.prepare("SELECT count FROM rate_limits").first<{ count: number }>();
    expect(despues?.count).toBe(50);
    const filas = await t.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>();
    expect(filas?.n).toBe(1);
  });

  it("peek() lee el contador de la ventana sin escribir", async () => {
    expect(await peek(t.DB, "b", "s", 60, T0)).toBe(0);
    await hit(t.DB, "b", "s", REGLA, T0);
    await hit(t.DB, "b", "s", REGLA, T0);
    expect(await peek(t.DB, "b", "s", 60, T0 + 5)).toBe(2);
    expect(await peek(t.DB, "b", "s", 60, T0 + 60_000)).toBe(0);
  });
});

describe("limpieza y métricas", () => {
  const t = useTestDb();

  it("borra las ventanas de más de 24 h y conserva las recientes", async () => {
    const ahora = T0 + 3 * 86_400_000;
    await hit(t.DB, "login", "viejo", { limit: 10, windowSec: 600 }, ahora - 2 * 86_400_000);
    await hit(t.DB, "login", "nuevo", { limit: 10, windowSec: 600 }, ahora - 3_600_000);
    expect(await limpiarRateLimits(t.DB, ahora)).toBe(1);
    const { results } = await t.DB.prepare("SELECT subject FROM rate_limits").all<{ subject: string }>();
    expect(results.map((r) => r.subject)).toEqual(["nuevo"]);
  });

  it("OB2: cuenta bloqueos y sujetos distintos por bucket, sin exponer sujetos", async () => {
    for (let i = 0; i < 13; i++) await hit(t.DB, "login", "a", { limit: 10, windowSec: 600 }, T0);
    await hit(t.DB, "login", "b", { limit: 10, windowSec: 600 }, T0);
    const m = await metricasRateLimit(t.DB, T0 + 1_000);
    const login = m.ultimas24h.find((b) => b.bucket === "login");
    expect(login).toMatchObject({ limit: 10, hits: 14, blocked: 3, subjects: 2 });
    expect(m.filas).toBe(2);
    expect(JSON.stringify(m)).not.toContain('"a"');
  });
});
