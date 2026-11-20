// Límite por IP del link de invitación (docs/37 D6): el GET de /prode/unirse/[código] confirma si un
// código existe, así que también se limita, en memoria del isolate (lectura pública, docs/16 D4).
import { beforeEach, describe, expect, it } from "vitest";
import { limiteInvitacion } from "../../../src/lib/prode/limite-invitacion";
import { POLICIES } from "../../../src/lib/rate-limit/policies";
import { reiniciarMemoria } from "../../../src/lib/rate-limit/memory";
import { reiniciarConfig } from "../../../src/lib/rate-limit/config";

const pedido = (ip?: string) => new Request("https://fisture.test/prode/unirse/ABCDEFGH", { headers: ip ? { "cf-connecting-ip": ip } : {} });

describe("limiteInvitacion", () => {
  beforeEach(() => (reiniciarMemoria(), reiniciarConfig()));

  it(`deja ${POLICIES.prode_invitacion_ip.limit} visitas por IP y ventana; la siguiente espera`, async () => {
    const { limit } = POLICIES.prode_invitacion_ip;
    for (let i = 0; i < limit; i++) expect(await limiteInvitacion(pedido("203.0.113.7"), {})).toBeNull();
    const espera = await limiteInvitacion(pedido("203.0.113.7"), {});
    expect(espera).toBeGreaterThan(0);
    // Otra IP no comparte el contador
    expect(await limiteInvitacion(pedido("203.0.113.8"), {})).toBeNull();
  });

  it("sin IP no limita (no hay sujeto)", async () => {
    for (let i = 0; i < 100; i++) expect(await limiteInvitacion(pedido(), {})).toBeNull();
  });

  it("respeta el apagado y el modo observar del limitador", async () => {
    for (let i = 0; i < 100; i++) expect(await limiteInvitacion(pedido("203.0.113.9"), { RATE_LIMIT_DISABLED: "true" })).toBeNull();
    for (let i = 0; i < 100; i++) expect(await limiteInvitacion(pedido("203.0.113.10"), { RATE_LIMIT_MODE: "observe" })).toBeNull();
  });

  it("la política es por IP y en memoria (no escribe en D1 por cada visita)", () => {
    expect(POLICIES.prode_invitacion_ip).toMatchObject({ scope: "ip", store: "memory" });
  });
});
