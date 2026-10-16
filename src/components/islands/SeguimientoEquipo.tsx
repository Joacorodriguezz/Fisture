import { useState } from "react";
import Segmentado from "./Segmentado";

interface Props {
  teamId: string;
  nombre: string;
  siguiendo: boolean;
  autoSync: boolean;
}

// Acciones de seguimiento de la ficha de equipo: seguir, dejar de seguir y auto-sync.
// El estado vive en la island: no hace falta recargar la página.
export default function SeguimientoEquipo({ teamId, nombre, siguiendo: siguiendoInicial, autoSync }: Props) {
  const [siguiendo, setSiguiendo] = useState(siguiendoInicial);
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function seguir() {
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch("/api/equipos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      if (!res.ok && res.status !== 409) throw new Error("follow failed");
      setSiguiendo(true);
    } catch {
      setError("No se pudo seguir el equipo. Probá de nuevo.");
    } finally {
      setOcupado(false);
    }
  }

  async function dejarDeSeguir() {
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch(`/api/equipos/${teamId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("unfollow failed");
      setSiguiendo(false);
      setConfirmando(false);
    } catch {
      setError("No se pudo dejar de seguir. Probá de nuevo.");
    } finally {
      setOcupado(false);
    }
  }

  if (!siguiendo) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
        <button type="button" className="tb-boton tb-boton--primario" disabled={ocupado} onClick={seguir}>
          {ocupado ? "Siguiendo…" : "Seguir equipo"}
        </button>
        {error && <span className="tb-error">{error}</span>}
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ font: "700 14px/18px var(--font-rotulo)", letterSpacing: ".06em", textTransform: "uppercase" }}>
          Auto-sync
        </span>
        <Segmentado
          ariaLabel="Auto-sync del equipo"
          opciones={[
            { label: "Sí", value: true },
            { label: "No", value: false },
          ]}
          valor={autoSync}
          endpoint={`/api/equipos/${teamId}`}
          campo="autoSync"
        />
      </div>

      {confirmando ? (
        <div role="alertdialog" aria-label={`Confirmar: dejar de seguir a ${nombre}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <span style={{ font: "700 14px/18px var(--font-rotulo)", textTransform: "uppercase" }}>¿Dejar de seguir a {nombre}?</span>
          <button type="button" className="tb-boton tb-boton--primario" disabled={ocupado} onClick={dejarDeSeguir}>
            Sí, dejar de seguir
          </button>
          <button type="button" className="tb-boton" disabled={ocupado} onClick={() => setConfirmando(false)}>
            Cancelar
          </button>
        </div>
      ) : (
        <button type="button" className="tb-boton" disabled={ocupado} onClick={() => setConfirmando(true)}>
          Dejar de seguir
        </button>
      )}
      {error && <span className="tb-error">{error}</span>}
    </div>
  );
}
