import { useState } from "react";
import { irALogin } from "../../../lib/auth/client";

// Botón «Unirme» del link de invitación (docs/37 D9): unirse es un POST explícito, nunca un GET
interface Props {
  codigo: string;
  grupoId: string;
}

const MENSAJES: Record<string, string> = {
  grupo_lleno: "El grupo ya tiene 50 jugadores, el máximo.",
  limite_grupos: "Ya estás en 20 grupos: salí de alguno para sumarte.",
  codigo_inexistente: "El código cambió. Pedile a quien te invitó el link nuevo.",
  codigo_invalido: "El código no es válido. Pedile a quien te invitó el link nuevo.",
  rate_limited: "Demasiados intentos seguidos. Esperá unos minutos y probá de nuevo.",
};

export default function UnirseGrupo({ codigo, grupoId }: Props) {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unirse() {
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch("/api/prode/unirse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo }),
      });
      if (res.status === 401) return irALogin();
      const body = (await res.json().catch(() => ({}))) as { grupoId?: string; error?: string };
      if (res.ok) {
        location.href = `/prode/${body.grupoId ?? grupoId}?aviso=bienvenida`;
        return;
      }
      setError(MENSAJES[body.error ?? ""] ?? "No pudimos sumarte. Probá de nuevo.");
    } catch {
      setError("No pudimos sumarte. Revisá la conexión y probá de nuevo.");
    }
    setOcupado(false);
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, alignItems: "stretch" }}>
      <button type="button" className="tb-boton tb-boton--primario" disabled={ocupado} onClick={unirse}>
        {ocupado ? "Sumándote…" : "Unirme al prode"}
      </button>
      {error && (
        <p className="tb-error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
