import { useEffect, useRef, useState } from "react";
import { boton, rotulo, suave, texto } from "../prode/estilos";
import { mensajeDeError } from "../prode/logica";

// Une al usuario al grupo con el código del enlace (POST /api/prode/grupos/unirse, idempotente) y lo
// lleva al grupo. Cualquier fallo de código da el mismo mensaje: no se revela si el código existe.
export default function ProdeUnirse({ codigo }: { codigo: string }) {
  const [error, setError] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(true);
  const lanzado = useRef(false);

  async function unirse() {
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch("/api/prode/grupos/unirse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codigo }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (res.ok && data.id) {
        window.location.replace(`/prode/grupos/${encodeURIComponent(data.id)}`);
        return;
      }
      setError(mensajeDeError(res.status, data.error, "unirse"));
    } catch {
      setError("No se pudo completar la operación. Probá de nuevo.");
    }
    setOcupado(false);
  }

  useEffect(() => {
    if (lanzado.current) return;
    lanzado.current = true;
    void unirse();
  }, []);

  return (
    <div className="prode-formulario">
      {ocupado ? (
        <p role="status" style={suave}>Uniéndote al grupo…</p>
      ) : (
        <>
          <p role="alert" className="prode-formulario__error" style={rotulo}>No pudimos unirte</p>
          <p style={texto}>{error}</p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <button type="button" className="tb-boton tb-boton--primario" onClick={() => void unirse()} style={boton}>Reintentar</button>
            <a className="tb-boton" href="/prode/grupos" style={{ ...boton, display: "inline-flex", alignItems: "center", textDecoration: "none" }}>Mis grupos</a>
          </div>
        </>
      )}
    </div>
  );
}
