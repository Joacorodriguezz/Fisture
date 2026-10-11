// Estados de sincronización de un partido, con los textos y variantes del diseño.
// Se usa en Astro (SSR) y en las islands de React.

export type SyncStatus = "none" | "syncing" | "synced" | "needs_update" | "failed";

export interface SyncView {
  label: string; // texto corto del botón
  labelLargo: string; // texto del botón en la ficha del partido
  variante: "secundario" | "tinta" | "primario";
  estado: string; // línea de estado debajo del partido
  estadoColor: string;
  motivo: string; // explicación cuando hay que hacer algo
  disabled: boolean;
}

// Pasa el status guardado en DB (pending, synced, needs_update, failed) a un SyncStatus de UI
export function toSyncStatus(status: string | null | undefined): SyncStatus {
  if (status === "synced" || status === "needs_update" || status === "failed") return status;
  return "none";
}

export function syncView(status: SyncStatus, errorMessage?: string | null): SyncView {
  switch (status) {
    case "syncing":
      return {
        label: "Agregando…",
        labelLargo: "Agregando…",
        variante: "secundario",
        estado: "",
        estadoColor: "var(--tinta-suave)",
        motivo: "",
        disabled: true,
      };
    case "synced":
      return {
        label: "En calendario",
        labelLargo: "En tu calendario",
        variante: "tinta",
        estado: "■ En tu calendario",
        estadoColor: "var(--celeste)",
        motivo: "",
        disabled: false,
      };
    case "needs_update":
      return {
        label: "Actualizar",
        labelLargo: "Actualizar evento",
        variante: "primario",
        estado: "Cambió el horario",
        estadoColor: "var(--rojo)",
        motivo: "El partido cambió de fecha u hora. Tu evento todavía tiene el horario viejo.",
        disabled: false,
      };
    case "failed":
      return {
        label: "Reintentar",
        labelLargo: "Reintentar",
        variante: "primario",
        estado: "Falló la sincronización",
        estadoColor: "var(--rojo)",
        motivo: errorMessage || "No pudimos escribir el evento en tu calendario.",
        disabled: false,
      };
    default:
      return {
        label: "Agregar",
        labelLargo: "Agregar al calendario",
        variante: "secundario",
        estado: "",
        estadoColor: "var(--tinta-suave)",
        motivo: "",
        disabled: false,
      };
  }
}
