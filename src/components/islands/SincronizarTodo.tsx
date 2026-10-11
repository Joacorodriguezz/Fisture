import { useEffect, useState } from "react";

interface Props {
  matchIds: string[];
  etiqueta: string;
  etiquetaCargando?: string;
  variante?: "primario" | "tinta" | "secundario";
}

interface SyncResponse {
  results?: { matchId: string; success: boolean; error?: string }[];
}

// Clave del resumen que sobrevive a la recarga de la página
const CLAVE_RESUMEN = "fisture:sync-resumen";

// Sincroniza varios partidos de una vez. La lista y las estadísticas vienen del servidor,
// así que al terminar se recarga la página, pero el resumen del lote se muestra después.
export default function SincronizarTodo({
  matchIds,
  etiqueta,
  etiquetaCargando = "Sincronizando…",
  variante = "primario",
}: Props) {
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumen, setResumen] = useState<string | null>(null);

  // Lee el resumen dejado por el lote anterior (una sola vez)
  useEffect(() => {
    try {
      const guardado = sessionStorage.getItem(CLAVE_RESUMEN);
      if (guardado) {
        sessionStorage.removeItem(CLAVE_RESUMEN);
        setResumen(guardado);
      }
    } catch {
      // sessionStorage puede no estar disponible (modo privado): el resumen simplemente no aparece
    }
  }, []);

  async function sincronizar() {
    if (cargando || matchIds.length === 0) return;
    setCargando(true);
    setError(null);
    setResumen(null);

    try {
      const res = await fetch("/api/calendario/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchIds }),
      });
      if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}`);

      const data = (await res.json().catch(() => ({}))) as SyncResponse;
      const resultados = data.results ?? [];
      const ok = resultados.filter((r) => r.success).length;
      const fallo = resultados.length - ok;
      const texto = `${ok} ${ok === 1 ? "partido sincronizado" : "partidos sincronizados"}${fallo ? ` · ${fallo} ${fallo === 1 ? "falló" : "fallaron"}` : ""}`;

      try {
        sessionStorage.setItem(CLAVE_RESUMEN, texto);
      } catch {
        // Sin sessionStorage el resumen no se muestra, la recarga sigue funcionando
      }
      location.reload();
    } catch {
      setError("No se pudo sincronizar. Probá de nuevo.");
      setCargando(false);
    }
  }

  const clase = `tb-boton ${variante !== "secundario" ? `tb-boton--${variante}` : ""}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }} aria-live="polite">
      {resumen && <span style={{ font: "700 13px/16px var(--font-rotulo)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--celeste)" }}>✓ {resumen}</span>}
      <button type="button" className={clase} disabled={cargando || matchIds.length === 0} onClick={sincronizar}>
        {cargando ? etiquetaCargando : etiqueta}
      </button>
      {error && <span className="tb-error">{error}</span>}
    </div>
  );
}
