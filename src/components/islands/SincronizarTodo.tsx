import { useEffect, useState } from "react";
import { irALogin } from "../../lib/auth/client";
import { mensajeDeLimite } from "../../lib/sync-ui";
import { sincronizarEnLotes } from "../../lib/calendar/lotes";

interface Props {
  matchIds: string[];
  etiqueta: string;
  etiquetaCargando?: string;
  variante?: "primario" | "tinta" | "secundario";
  // Visitante sin sesión: pide iniciar sesión en vez de sincronizar
  anonimo?: boolean;
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
  anonimo = false,
}: Props) {
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resumen, setResumen] = useState<string | null>(null);
  const [progreso, setProgreso] = useState<string | null>(null);

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
    if (anonimo) return irALogin();
    if (cargando || matchIds.length === 0) return;
    setCargando(true);
    setError(null);
    setResumen(null);

    try {
      // Cada lote es una request aparte (docs/16 §12 R2), en secuencia y con progreso
      const r = await sincronizarEnLotes(matchIds, {
        enviar: (lote) =>
          fetch("/api/calendario/sync", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ matchIds: lote }),
          }),
        onProgreso: (hechos, total) => setProgreso(`${Math.min(hechos + 1, total)} de ${total}`),
      });
      if (r.sinSesion) return irALogin();

      if (r.limitado) {
        // Se frena sin recargar para que el mensaje no se pierda; lo ya agregado se ve al recargar
        const faltan = matchIds.length - r.ok - r.fallo;
        setError(`${mensajeDeLimite(r.retryAfter)} Se sincronizaron ${r.ok}; faltan ${faltan}.`);
        setCargando(false);
        setProgreso(null);
        return;
      }
      const { ok, fallo } = r;
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
      setProgreso(null);
    }
  }

  const clase = `tb-boton ${variante !== "secundario" ? `tb-boton--${variante}` : ""}`;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }} aria-live="polite">
      {resumen && <span style={{ font: "700 13px/16px var(--font-rotulo)", letterSpacing: ".04em", textTransform: "uppercase", color: "var(--celeste)" }}>✓ {resumen}</span>}
      <button type="button" className={clase} disabled={cargando || (!anonimo && matchIds.length === 0)} onClick={sincronizar}>
        {cargando ? (progreso ? `${etiquetaCargando.replace("…", "")} ${progreso}…` : etiquetaCargando) : etiqueta}
      </button>
      {error && <span className="tb-error">{error}</span>}
    </div>
  );
}
