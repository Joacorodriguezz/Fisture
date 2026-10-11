import { useState } from "react";
import Segmentado from "./Segmentado";

interface Props {
  teamId: string;
  nombre: string;
  siguiendo: boolean;
  autoSync: boolean;
}

// Acciones de seguimiento de la ficha de equipo: seguir, dejar de seguir y auto-sync
export default function SeguimientoEquipo({ teamId, nombre, siguiendo, autoSync }: Props) {
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
      location.reload();
    } catch {
      setError("No se pudo seguir el equipo");
      setOcupado(false);
    }
  }

  async function dejarDeSeguir() {
    if (!confirm(`¿Dejar de seguir a ${nombre}?`)) return;
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch(`/api/equipos/${teamId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("unfollow failed");
      location.reload();
    } catch {
      setError("No se pudo dejar de seguir");
      setOcupado(false);
    }
  }

  if (!siguiendo) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "flex-start" }}>
        <button type="button" className="tb-boton tb-boton--primario" disabled={ocupado} onClick={seguir}>
          Seguir equipo
        </button>
        {error && <span style={{ color: "var(--rojo)", font: "600 13px/16px var(--font-rotulo)" }}>{error}</span>}
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
      <button type="button" className="tb-boton" disabled={ocupado} onClick={dejarDeSeguir}>
        Dejar de seguir
      </button>
      {error && <span style={{ color: "var(--rojo)", font: "600 13px/16px var(--font-rotulo)" }}>{error}</span>}
    </div>
  );
}
