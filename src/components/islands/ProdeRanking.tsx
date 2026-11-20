import { useEffect, useState } from "react";
import { fila, rotulo, soloLectores, suave, texto, campo } from "../prode/estilos";
import { normalizarRanking, type FilaRanking } from "../prode/logica";

interface Props {
  // Endpoint de ranking sin query (ej. "/api/prode/ranking" o "/api/prode/ranking/<grupoId>").
  // Se le agrega ?fase=<fase> cuando hay una fase elegida.
  url: string;
  // Opciones del selector de fase; la primera ("") es el acumulado
  fases?: { valor: string; etiqueta: string }[];
}

const FASES = [
  { valor: "", etiqueta: "Total" },
  { valor: "octavos", etiqueta: "Octavos" },
  { valor: "cuartos", etiqueta: "Cuartos" },
  { valor: "semifinal", etiqueta: "Semifinal" },
  { valor: "final", etiqueta: "Final" },
];

// Ranking reutilizable (general o de un grupo). Contrato esperado de la respuesta (aún sin endpoint):
//   200 { "filas": [{ "posicion": 1, "nombre": "Ana", "puntos": 12, "exactos": 2, "esVos": true }, ...] }
// "exactos" es opcional. Con empates la posición se repite (1, 1, 3).
export default function ProdeRanking({ url, fases = FASES }: Props) {
  const [fase, setFase] = useState("");
  const [filas, setFilas] = useState<FilaRanking[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    setFilas(null);
    setError(null);
    fetch(fase ? `${url}?fase=${encodeURIComponent(fase)}` : url)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!vivo) return;
        if (!res.ok) setError(res.status === 429 ? "Demasiados intentos. Esperá un minuto." : "No se pudo cargar la tabla. Probá de nuevo.");
        else setFilas(normalizarRanking(data));
      })
      .catch(() => vivo && setError("No se pudo cargar la tabla. Probá de nuevo."));
    return () => {
      vivo = false;
    };
  }, [url, fase]);

  return (
    <div>
      <div style={{ ...fila, borderBottom: "none" }}>
        <label htmlFor="ranking-fase" style={rotulo}>Fase</label>
        <select id="ranking-fase" value={fase} onChange={(e) => setFase(e.target.value)} style={{ ...campo, maxWidth: 260 }}>
          {fases.map((f) => (
            <option key={f.valor} value={f.valor}>{f.etiqueta}</option>
          ))}
        </select>
      </div>
      <div aria-live="polite">
        {error ? (
          <p role="alert" style={{ ...texto, padding: 12, color: "var(--alerta, #b00020)" }}>{error}</p>
        ) : !filas ? (
          <p style={{ ...suave, padding: 12 }}>Cargando posiciones…</p>
        ) : filas.length === 0 ? (
          <p style={{ ...suave, padding: 12 }}>Todavía no hay posiciones para mostrar.</p>
        ) : (
          <table className="tb-tabla" style={{ width: "100%", borderCollapse: "collapse" }}>
            <caption style={soloLectores}>Posiciones del prode</caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left", padding: "8px 12px" }}>Pos.</th>
                <th scope="col" style={{ textAlign: "left", padding: "8px 12px" }}>Nombre</th>
                <th scope="col" style={{ textAlign: "right", padding: "8px 12px" }}>Puntos</th>
              </tr>
            </thead>
            <tbody>
              {filas.map((f, n) => (
                <tr key={n} aria-current={f.esVos ? "true" : undefined} style={f.esVos ? { background: "var(--amarillo)", color: "var(--on-amarillo)", fontWeight: 700 } : undefined}>
                  <td style={{ padding: "10px 12px" }}>{f.posicion}</td>
                  <td style={{ padding: "10px 12px" }}>{f.nombre}{f.esVos ? " (vos)" : ""}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}>{f.puntos}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
