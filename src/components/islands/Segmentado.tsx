import { useState } from "react";
import { segmentoStyle } from "./estilos";

interface Opcion {
  label: string;
  value: boolean | string;
}

interface Props {
  opciones: Opcion[];
  valor: boolean | string;
  // Endpoint que recibe PATCH con { [campo]: valor }
  endpoint: string;
  campo: string;
  ariaLabel: string;
  // Recarga la página al guardar (ej: cambio de tema)
  recargar?: boolean;
}

export default function Segmentado({ opciones, valor, endpoint, campo, ariaLabel, recargar = false }: Props) {
  const [actual, setActual] = useState(valor);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function elegir(nuevo: boolean | string) {
    if (nuevo === actual || guardando) return;

    const anterior = actual;
    setActual(nuevo);
    setGuardando(true);
    setError(null);

    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [campo]: nuevo }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (recargar) location.reload();
    } catch {
      setActual(anterior);
      setError("No se pudo guardar. Probá de nuevo.");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
      <div role="group" aria-label={ariaLabel} style={{ display: "flex" }}>
        {opciones.map((o) => {
          const activo = o.value === actual;
          return (
            <button
              key={String(o.value)}
              type="button"
              aria-pressed={activo}
              disabled={guardando}
              onClick={() => elegir(o.value)}
              style={{ ...segmentoStyle(activo), opacity: guardando ? 0.6 : 1 }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      {error && <span style={{ color: "var(--rojo)", font: "600 13px/16px var(--font-rotulo)" }}>{error}</span>}
    </div>
  );
}
