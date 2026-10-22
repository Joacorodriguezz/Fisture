import { expect, it, vi } from "vitest";
import { runSmoke } from "../../scripts/production-smoke.mjs";

function healthy(url: URL) {
  if (url.pathname === "/api/health") return Response.json({ status: "ok", checks: { db: "ok", kv: "ok", sync: "ok" } });
  if (url.pathname === "/api/admin/status") return new Response(null, { status: 401 });
  return new Response("<html><title>FISTURE</title></html>", { headers: { "Content-Type": "text/html" } });
}

it("smoke solo consulta endpoints públicos y rechaza salud rota", async () => {
  const fetchImpl = vi.fn(async (url: URL) => healthy(url));
  await runSmoke("https://example.test", { fetchImpl, wait: async () => {} });
  expect(fetchImpl).toHaveBeenCalledTimes(6);
  expect(fetchImpl.mock.calls.every(([url]) => url.origin === "https://example.test")).toBe(true);
  await expect(runSmoke("https://example.test", { fetchImpl: async () => new Response(null, { status: 503 }), attempts: 1 })).rejects.toThrow("Smoke falló en /");
});

it("reintenta despliegues transitorios y detecta admin expuesto o DB rota", async () => {
  const fetchImpl = vi.fn(async (url: URL) => healthy(url)).mockImplementationOnce(async () => new Response(null, { status: 503 }));
  const wait = vi.fn(async () => {});
  await runSmoke("http://localhost:4322", { fetchImpl, wait });
  expect(wait).toHaveBeenCalledTimes(1);
  await expect(runSmoke("https://example.test", {
    attempts: 1, fetchImpl: async (url: URL) => url.pathname === "/api/health" ? Response.json({ status: "ok", checks: { db: "fail", kv: "ok", sync: "ok" } }) : healthy(url),
  })).rejects.toThrow("/api/health");
  await expect(runSmoke("https://example.test", {
    attempts: 1, fetchImpl: async (url: URL) => url.pathname === "/api/admin/status" ? Response.json({}) : healthy(url),
  })).rejects.toThrow("/api/admin/status");
});
