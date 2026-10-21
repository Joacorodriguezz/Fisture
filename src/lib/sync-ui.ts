// Estados de sincronización de un partido, con los textos y variantes del diseño.
// Se usa en Astro (SSR) y en las islands de React.
// Vocabulario único: Agregar · Actualizar · Reintentar. Cada estado también se distingue por ícono, no solo por color.

export type SyncStatus = "none" | "syncing" | "synced" | "needs_update" | "failed" | "detached" | "cancelled";

export interface SyncView {
  label: string; // texto corto del botón (listas)
  labelLargo: string; // texto del botón en la ficha del partido
  variante: "secundario" | "tinta" | "primario";
  estado: string; // línea de estado debajo del partido
  estadoColor: string;
  motivo: string; // explicación cuando hay que hacer algo
  disabled: boolean;
}

// Pasa el status guardado en DB (pending, synced, needs_update, failed, detached, cancelled) a un SyncStatus de UI
export function toSyncStatus(status: string | null | undefined): SyncStatus {
  if (status === "synced" || status === "needs_update" || status === "failed" || status === "detached" || status === "cancelled") return status;
  return "none";
}

// Estados en los que un lote ("sincronizar todo") debe intentar algo. detached lo quitó el usuario a mano
// y cancelled no tiene evento: ninguno entra en un lote, solo un clic individual recrea un detached.
export function esAccionable(status: SyncStatus): boolean {
  return status === "none" || status === "needs_update" || status === "failed";
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
      // Informativo: ya está en el calendario. Quitarlo es una acción aparte (ficha del partido).
      return {
        label: "En calendario",
        labelLargo: "En tu calendario",
        variante: "tinta",
        estado: "✓ En tu calendario",
        estadoColor: "var(--celeste)",
        motivo: "",
        disabled: true,
      };
    case "needs_update":
      return {
        label: "Actualizar",
        labelLargo: "Actualizar evento",
        variante: "primario",
        estado: "↻ Reprogramado",
        estadoColor: "var(--rojo)",
        motivo: "El partido cambió de fecha, hora, estadio o estado. Tu evento todavía no lo refleja.",
        disabled: false,
      };
    case "cancelled":
      // El evento se quitó solo; no hay nada para hacer hasta que el partido vuelva a jugarse
      return {
        label: "Cancelado",
        labelLargo: "Partido cancelado",
        variante: "secundario",
        estado: "✕ Partido cancelado",
        estadoColor: "var(--rojo)",
        motivo: "",
        disabled: true,
      };
    case "failed":
      return {
        label: "Reintentar",
        labelLargo: "Reintentar",
        variante: "primario",
        estado: "▲ Falló la sincronización",
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
