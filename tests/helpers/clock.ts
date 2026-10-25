// Reloj fijo para los tests: sin esto, las fechas relativas a Date.now() dejan de ser "futuras"
// o "pasadas" con el paso del tiempo. Solo se simula Date (los timers reales los necesita Miniflare).
import { afterEach, beforeEach, vi } from "vitest";

export const AHORA = new Date("2026-10-21T15:00:00Z");
export const DIA_MS = 86_400_000;
export const HORA_MS = 3_600_000;

// Registra los hooks que fijan y restauran el reloj en cada test del describe actual
export function relojFijo(ahora: Date = AHORA): Date {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(ahora);
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  return ahora;
}
