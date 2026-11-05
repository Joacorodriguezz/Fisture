import { useState } from "react";

interface Props {
  provider: "google" | "microsoft";
  etiqueta: string;
}

// Desvincula un proveedor de la cuenta (docs/18 D9). El servidor vuelve a validar sesión, Origin y reglas.
export default function DesvincularProveedor({ provider, etiqueta }: Props) {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function desvincular() {
    if (ocupado) return;
    if (!window.confirm(`¿Desvincular ${etiqueta}? Ya no vas a poder entrar con esa cuenta.`)) return;
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/identidades/${provider}`, { method: "DELETE" });
      if (!res.ok) throw new Error("unlink failed");
      location.href = "/configuracion";
    } catch {
      setError("No se pudo desvincular. Probá de nuevo.");
      setOcupado(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      <button type="button" className="tb-boton" onClick={desvincular} disabled={ocupado}>
        {ocupado ? "Desvinculando..." : "Desvincular"}
      </button>
      {error && (
        <span role="alert" style={{ font: "400 14px/19px var(--font-texto)", color: "var(--rojo-fondo)" }}>
          {error}
        </span>
      )}
    </span>
  );
}
