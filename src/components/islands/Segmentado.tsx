import { useEffect, useState } from "react";

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
  // Aplica el tema en la página al instante (sin recargar)
  aplicarTema?: boolean;
}

export default function Segmentado({ opciones, valor, endpoint, campo, ariaLabel, aplicarTema = false }: Props) {
  const [actual, setActual] = useState(valor);
  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [guardado, setGuardado] = useState(false);

  // El aviso "Guardado" desaparece solo
  useEffect(() => {
    if (!guardado) return;
    const t = setTimeout(() => setGuardado(false), 2000);
    return () => clearTimeout(t);
  }, [guardado]);

  async function elegir(nuevo: boolean | string) {
    if (nuevo === actual || guardando) return;

    const anterior = actual;
    setActual(nuevo);
    setGuardando(true);
    setError(null);
    setGuardado(false);
    if (aplicarTema && typeof nuevo === "string") document.documentElement.dataset.theme = nuevo;

    try {
      const res = await fetch(endpoint, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [campo]: nuevo }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setGuardado(true);
    } catch {
      setActual(anterior);
      if (aplicarTema && typeof anterior === "string") document.documentElement.dataset.theme = anterior;
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
              className={activo ? "tb-segmento tb-chip--activo" : "tb-segmento"}
            >
              {o.label}
            </button>
          );
        })}
      </div>
      <span aria-live="polite">
        {guardando && <span className="tb-meta">Guardando…</span>}
        {guardado && <span className="tb-ok">✓ Guardado</span>}
        {error && <span className="tb-error">{error}</span>}
      </span>
    </div>
  );
}
