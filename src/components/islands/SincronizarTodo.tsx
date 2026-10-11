import { useState } from "react";

interface Props {
  matchIds: string[];
  etiqueta: string;
  etiquetaCargando?: string;
  variante?: "primario" | "tinta" | "secundario";
}

// Sincroniza varios partidos de una vez y recarga la página con el nuevo estado
export default function SincronizarTodo({
  matchIds,
  etiqueta,
  etiquetaCargando = "Sincronizando…",
  variante = "primario",
}: Props) {
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sincronizar() {
    if (cargando || matchIds.length === 0) return;
    setCargando(true);
    setError(null);

    try {
      const res = await fetch("/api/calendario/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchIds }),
      });
      if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}`);
      location.reload();
    } catch {
      setError("No se pudo sincronizar. Probá de nuevo.");
      setCargando(false);
    }
  }

  const clase = `tb-boton ${variante !== "secundario" ? `tb-boton--${variante}` : ""}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
      <button type="button" className={clase} disabled={cargando || matchIds.length === 0} onClick={sincronizar}>
        {cargando ? etiquetaCargando : etiqueta}
      </button>
      {error && <span style={{ color: "var(--rojo)", font: "600 13px/16px var(--font-rotulo)" }}>{error}</span>}
    </div>
  );
}
