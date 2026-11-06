import { beforeEach, describe, expect, it } from "vitest";
import { modoLimite, reiniciarConfig, TTL_CONFIG_MS, VIGENCIA_MAX_SIN_KV_MS } from "../../../src/lib/rate-limit/config";

describe("interruptor del límite de tasa con KV caído", () => {
  beforeEach(() => reiniciarConfig());

  it("conserva el último valor de KV mientras no pase la vigencia máxima, y después vuelve al secret", async () => {
    let caido = false;
    const KV = {
      get: async () => {
        if (caido) throw new Error("KV caído");
        return "off";
      },
    };
    const t0 = 1_000_000;
    expect(await modoLimite({ KV }, t0)).toEqual({ disabled: true, observe: false });

    caido = true;
    // Vencido el TTL pero dentro de la vigencia: sigue el "off" conocido
    expect(await modoLimite({ KV }, t0 + TTL_CONFIG_MS + 1)).toEqual({ disabled: true, observe: false });

    // Pasada la vigencia máxima sin una lectura buena: manda el secret de arranque (bloqueo activo)
    expect(await modoLimite({ KV }, t0 + VIGENCIA_MAX_SIN_KV_MS + 1)).toEqual({ disabled: false, observe: false });
  });
});
