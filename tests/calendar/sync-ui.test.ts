import { describe, expect, it } from "vitest";
import { esAccionable, syncView, toSyncStatus } from "../../src/lib/sync-ui";

describe("estados de sincronización en la UI", () => {
  it("mapea los estados nuevos de la base", () => {
    expect(toSyncStatus("detached")).toBe("detached");
    expect(toSyncStatus("cancelled")).toBe("cancelled");
    expect(toSyncStatus("pending")).toBe("none");
    expect(toSyncStatus(null)).toBe("none");
  });

  it("un detached vuelve a ofrecer Agregar (D5)", () => {
    expect(syncView("detached")).toMatchObject({ label: "Agregar", disabled: false });
  });

  it("un cancelado no ofrece ninguna acción", () => {
    expect(syncView("cancelled")).toMatchObject({ labelLargo: "Partido cancelado", disabled: true });
  });

  it("un reprogramado ofrece Actualizar", () => {
    expect(syncView("needs_update")).toMatchObject({ label: "Actualizar", estado: "↻ Reprogramado", disabled: false });
  });

  it("los lotes solo intentan none, needs_update y failed", () => {
    expect(["none", "needs_update", "failed"].every((s) => esAccionable(s as never))).toBe(true);
    expect(["synced", "detached", "cancelled", "syncing"].some((s) => esAccionable(s as never))).toBe(false);
  });
});
