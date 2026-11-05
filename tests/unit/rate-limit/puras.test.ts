import { describe, expect, it } from "vitest";
import { ventana } from "../../../src/lib/rate-limit/limiter";
import { COSTO_FIJO_REQUEST, COSTO_PARTIDO_PEOR_CASO, MAX_PARTIDOS_POR_REQUEST, SUBREQUESTS_FREE } from "../../../src/lib/calendar/limites";
import { hashIp, ipDe, normalizarIp, saltDe, sujetoIp } from "../../../src/lib/rate-limit/subject";
import { hitMemory, reiniciarMemoria } from "../../../src/lib/rate-limit/memory";
import { POLICIES, politicasPorDefecto } from "../../../src/lib/rate-limit/policies";

describe("ventana", () => {
  it("RL2: Retry-After es el resto de la ventana, redondeado hacia arriba y mínimo 1", () => {
    const inicio = 1_800_000_000_000 - (1_800_000_000_000 % 60_000);
    expect(ventana(inicio + 23_000, 60)).toEqual({ windowStart: inicio, retryAfter: 37 });
    expect(ventana(inicio + 23_400, 60).retryAfter).toBe(37);
    expect(ventana(inicio + 59_999, 60).retryAfter).toBe(1);
    expect(ventana(inicio, 60).retryAfter).toBe(60);
  });

  it("RL3: dos instantes de ventanas distintas tienen distinto windowStart", () => {
    const a = ventana(1_000_000, 60).windowStart;
    expect(ventana(1_000_000 + 60_000, 60).windowStart).toBe(a + 60_000);
  });
});

describe("subject", () => {
  it("hashIp es determinístico, no contiene la IP y depende del salt", async () => {
    const a = await hashIp("203.0.113.9", "salt-1");
    expect(a).toBe(await hashIp("203.0.113.9", "salt-1"));
    expect(a).not.toContain("203");
    expect(a).toHaveLength(22);
    expect(a).not.toBe(await hashIp("203.0.113.9", "salt-2"));
    expect(a).not.toBe(await hashIp("203.0.113.10", "salt-1"));
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("ipDe lee cf-connecting-ip y devuelve null si falta (RL10)", () => {
    expect(ipDe(new Request("https://x.test", { headers: { "cf-connecting-ip": " 1.2.3.4 " } }))).toBe("1.2.3.4");
    expect(ipDe(new Request("https://x.test"))).toBeNull();
  });

  it("saltDe prefiere RATE_LIMIT_SALT y cae a ADMIN_SECRET", () => {
    expect(saltDe({ RATE_LIMIT_SALT: "a", ADMIN_SECRET: "b" })).toBe("a");
    expect(saltDe({ ADMIN_SECRET: "b" })).toBe("b");
    expect(saltDe({})).toBeNull();
  });
});

describe("normalizarIp (IPv6 al /64)", () => {
  it("IPv4 queda intacta", () => {
    expect(normalizarIp("203.0.113.9")).toBe("203.0.113.9");
  });

  it("IPv6 completa y comprimida del mismo /64 dan el mismo prefijo", () => {
    const esperado = "2001:db8:abcd:12::/64";
    expect(normalizarIp("2001:0db8:abcd:0012:0000:0000:0000:0001")).toBe(esperado);
    expect(normalizarIp("2001:db8:abcd:12::1")).toBe(esperado);
    expect(normalizarIp("2001:DB8:ABCD:12:ffff:ffff:ffff:ffff")).toBe(esperado);
    expect(normalizarIp("2001:db8:abcd:13::1")).not.toBe(esperado);
  });

  it("comprime en la cabeza y en el medio", () => {
    expect(normalizarIp("::1")).toBe("0:0:0:0::/64");
    expect(normalizarIp("2001:db8::")).toBe("2001:db8:0:0::/64");
    expect(normalizarIp("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
  });

  it("IPv4-mapped se reduce a su IPv4 (en ambas notaciones)", () => {
    expect(normalizarIp("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(normalizarIp("::ffff:cb00:7109")).toBe("203.0.113.9");
  });

  it("un valor que no es IP se devuelve tal cual", () => {
    expect(normalizarIp("no-es-ip")).toBe("no-es-ip");
    expect(normalizarIp("1:2:3")).toBe("1:2:3");
  });

  it("sujetoIp: dos IPv6 del mismo /64 comparten sujeto y una IPv4 no cambia", async () => {
    const pedir = (ip: string) => sujetoIp(new Request("https://x.test", { headers: { "cf-connecting-ip": ip } }), { RATE_LIMIT_SALT: "s" });
    expect(await pedir("2001:db8:1:2::1")).toBe(await pedir("2001:db8:1:2:aaaa::9"));
    expect(await pedir("2001:db8:1:3::1")).not.toBe(await pedir("2001:db8:1:2::1"));
    expect(await pedir("203.0.113.9")).toBe(await hashIp("203.0.113.9", "s"));
  });
});

describe("limitador en memoria", () => {
  it("RL15: la request limit+1 se bloquea y la ventana siguiente reinicia", () => {
    reiniciarMemoria();
    for (let i = 0; i < 60; i++) expect(hitMemory("ip1", 60, 60, 1_000).allowed).toBe(true);
    const bloqueada = hitMemory("ip1", 60, 60, 1_000);
    expect(bloqueada.allowed).toBe(false);
    expect(bloqueada.retryAfter).toBeGreaterThanOrEqual(1);
    expect(hitMemory("ip2", 60, 60, 1_000).allowed).toBe(true);
    expect(hitMemory("ip1", 60, 60, 1_000 + 60_000).allowed).toBe(true);
  });
});

describe("tope de partidos por request (subrequests de Workers Free)", () => {
  it("RL11b: el peor caso de un lote completo cabe en las 50 subrequests", () => {
    expect(MAX_PARTIDOS_POR_REQUEST).toBe(6);
    expect(COSTO_FIJO_REQUEST + MAX_PARTIDOS_POR_REQUEST * COSTO_PARTIDO_PEOR_CASO).toBeLessThanOrEqual(SUBREQUESTS_FREE);
    expect(COSTO_FIJO_REQUEST + (MAX_PARTIDOS_POR_REQUEST + 1) * COSTO_PARTIDO_PEOR_CASO).toBeGreaterThan(SUBREQUESTS_FREE);
  });
});

describe("policies", () => {
  it("D6: una mutación sin política explícita cae en las genéricas; una lectura en ninguna", () => {
    expect(politicasPorDefecto("POST")).toEqual(["mutation_ip", "mutation"]);
    expect(politicasPorDefecto("DELETE")).toEqual(["mutation_ip", "mutation"]);
    expect(politicasPorDefecto("GET")).toEqual([]);
  });

  it("los valores son los del TDD §5.3", () => {
    expect(POLICIES.login).toMatchObject({ limit: 10, windowSec: 600, scope: "ip" });
    expect(POLICIES.oauth_callback).toMatchObject({ limit: 20, windowSec: 600, scope: "ip" });
    expect(POLICIES.calendar_sync).toMatchObject({ limit: 10, windowSec: 60, scope: "user" });
    expect(POLICIES.calendar_sync_hour).toMatchObject({ limit: 60, windowSec: 3600, scope: "user" });
    expect(POLICIES.admin_fail).toMatchObject({ limit: 5, windowSec: 900, scope: "ip" });
    expect(POLICIES.search_public).toMatchObject({ limit: 60, windowSec: 60, store: "memory" });
  });
});
