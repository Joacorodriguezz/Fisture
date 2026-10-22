import { useState } from "react";
import { syncView, toSyncStatus, type SyncStatus } from "../../lib/sync-ui";
import { irALogin } from "../../lib/auth/client";

interface Aviso {
  code: string;
  count: number;
  items: { title: string; start: string; end: string }[];
}

interface SyncResponse {
  results?: { matchId: string; success: boolean; error?: string; warnings?: Aviso[] }[];
  error?: string;
}

interface Props {
  matchId: string;
  // Status guardado en DB para este usuario (null si nunca se agregó)
  status: string | null;
  errorMessage?: string | null;
  // Ficha del partido: botón más grande y opción de quitarlo del calendario
  grande?: boolean;
  permitirQuitar?: boolean;
  // Visitante sin sesión: agregar al calendario pide iniciar sesión
  anonimo?: boolean;
  // Versión compacta para filas de lista en mobile
  compacto?: boolean;
}

export default function SincronizarPartido({
  matchId,
  status,
  errorMessage = null,
  grande = false,
  permitirQuitar = false,
  anonimo = false,
  compacto = false,
}: Props) {
  const [estado, setEstado] = useState<SyncStatus>(toSyncStatus(status));
  const [error, setError] = useState<string | null>(errorMessage);
  const [quitando, setQuitando] = useState(false);
  // Títulos de eventos propios del usuario que se superponen con el partido (solo se muestran, no se guardan)
  const [solapados, setSolapados] = useState<string[]>([]);

  const vista = syncView(estado, error);

  async function agregar() {
    if (estado === "synced" || estado === "syncing") return;
    if (anonimo) return irALogin();

    setEstado("syncing");
    setError(null);

    try {
      const res = await fetch("/api/calendario/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId }),
      });
      if (res.status === 401) return irALogin();
      const data = (await res.json()) as SyncResponse;
      const resultado = data.results?.[0];

      if (res.ok && resultado?.success) {
        setEstado("synced");
        const choque = resultado.warnings?.find((w) => w.code === "overlap");
        setSolapados(choque ? choque.items.map((i) => i.title) : []);
      } else {
        setEstado("failed");
        setError(resultado?.error || data.error || "Error al sincronizar");
      }
    } catch {
      setEstado("failed");
      setError("Error de conexión");
    }
  }

  async function quitar() {
    if (quitando) return;
    setQuitando(true);
    try {
      const res = await fetch(`/api/calendario/sync?matchId=${matchId}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as SyncResponse;
      if (!res.ok) throw new Error(data.error || "No se pudo quitar del calendario");
      setEstado("none");
      setError(null);
      setSolapados([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo quitar del calendario");
    } finally {
      setQuitando(false);
    }
  }

  const clase = `tb-boton ${compacto ? "tb-boton--compacto " : ""}${vista.variante !== "secundario" ? `tb-boton--${vista.variante}` : ""}`;
  const mostrarMotivo = estado === "failed" || estado === "needs_update";

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: grande ? "flex-start" : "flex-end",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
        <button type="button" className={clase} disabled={vista.disabled} onClick={agregar}>
          {anonimo && estado === "none" ? (compacto ? "Iniciá sesión" : "Iniciá sesión para agregar") : grande ? vista.labelLargo : vista.label}
        </button>
        {permitirQuitar && estado === "synced" && (
          <button type="button" className="tb-boton" disabled={quitando} onClick={quitar}>
            Quitar del calendario
          </button>
        )}
      </div>
      {vista.estado && (
        <span
          style={{
            font: compacto ? "700 12px/14px var(--font-rotulo)" : "700 13px/16px var(--font-rotulo)",
            letterSpacing: ".04em",
            textTransform: "uppercase",
            color: vista.estadoColor,
          }}
        >
          {vista.estado}
        </span>
      )}
      {mostrarMotivo && (
        <span
          style={{
            font: "400 14px/19px var(--font-texto)",
            color: "var(--tinta-suave)",
            maxWidth: compacto ? 140 : 320,
            textAlign: grande ? "left" : "right",
          }}
        >
          {vista.motivo}
        </span>
      )}
      {solapados.length > 0 && (
        <span
          role="status"
          style={{
            font: "400 14px/19px var(--font-texto)",
            color: "var(--tinta-suave)",
            maxWidth: 320,
            textAlign: grande ? "left" : "right",
          }}
        >
          Se superpone con: {solapados.join(", ")}
        </span>
      )}
      {error && estado !== "failed" && <span className="tb-error">{error}</span>}
    </div>
  );
}
