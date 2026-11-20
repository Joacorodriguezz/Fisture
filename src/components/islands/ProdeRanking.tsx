import { useEffect, useState } from "react";
import { rotulo, soloLectores, suave, campo } from "../prode/estilos";
import { filaPropiaAparte, normalizarRespuestaRanking, type RespuestaRanking } from "../prode/logica";

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
//   200 { "filas": [{ "posicion": 1, "nombre": "Ana", "puntos": 12, "exactos": 2, "esVos": true }, ...], "total": 130, "yo": { ...fila propia, solo útil si queda fuera de "filas" } }
// "exactos" es opcional. Con empates la posición se repite (1, 1, 3).
export default function ProdeRanking({ url, fases = FASES }: Props) {
  const [fase, setFase] = useState("");
  const [datos, setDatos] = useState<RespuestaRanking | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const actualizar = () => setRevision((n) => n + 1);
    const general = document.querySelector("[data-ranking-general]");
    const verTotal = () => setFase("");
    general?.addEventListener("click", verTotal);
    window.addEventListener("prode:pronostico-guardado", actualizar);
    return () => {
      general?.removeEventListener("click", verTotal);
      window.removeEventListener("prode:pronostico-guardado", actualizar);
    };
  }, []);

  useEffect(() => {
    let vivo = true;
    setDatos(null);
    setError(null);
    fetch(fase ? `${url}?fase=${encodeURIComponent(fase)}` : url)
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!vivo) return;
        if (!res.ok) setError(res.status === 429 ? "Demasiados intentos. Esperá un minuto." : "No se pudo cargar la tabla. Probá de nuevo.");
        else setDatos(normalizarRespuestaRanking(data));
      })
      .catch(() => vivo && setError("No se pudo cargar la tabla. Probá de nuevo."));
    return () => {
      vivo = false;
    };
  }, [url, fase, revision]);

  const propia = datos ? filaPropiaAparte(datos.filas, datos.yo) : null;

  return (
    <div>
      <div className="prode-ranking__filtro">
        <label htmlFor="ranking-fase" style={rotulo}>Fase</label>
        <select id="ranking-fase" value={fase} onChange={(e) => setFase(e.target.value)} style={campo}>
          {fases.map((f) => (
            <option key={f.valor} value={f.valor}>{f.etiqueta}</option>
          ))}
        </select>
      </div>
      <div aria-live="polite">
        {error ? (
          <p role="alert" className="prode-estado-vacio">{error}</p>
        ) : !datos ? (
          <p className="prode-estado-vacio">Cargando posiciones…</p>
        ) : datos.filas.length === 0 ? (
          <p className="prode-estado-vacio">Todavía no hay posiciones para mostrar.</p>
        ) : (
          <>
          <table className="tb-tabla prode-ranking__tabla">
            <caption style={soloLectores}>Posiciones del prode</caption>
            <thead>
              <tr>
                <th scope="col">Pos.</th>
                <th scope="col">Nombre</th>
                <th scope="col"><abbr title="Exactos" aria-label="Exactos">Ex.</abbr></th>
                <th scope="col"><abbr title="Aciertos" aria-label="Aciertos">Ac.</abbr></th>
                <th scope="col">Puntos</th>
              </tr>
            </thead>
            <tbody>
              {datos.filas.map((f, n) => (
                <tr key={n} aria-current={f.esVos ? "true" : undefined}>
                  <td>{f.posicion}</td>
                  <td>{f.nombre}{f.esVos ? " (vos)" : ""}</td>
                  <td>{f.exactos ?? "–"}</td>
                  <td>{f.aciertos ?? "–"}</td>
                  <td>{f.puntos}</td>
                </tr>
              ))}
            </tbody>
            {propia && (
              <tbody aria-label="Tu posición">
                <tr>
                  <th scope="colgroup" colSpan={5} style={{ ...suave, textAlign: "left", padding: "8px 12px", borderTop: "1px solid currentColor", fontWeight: 400 }}>
                    Tu posición{datos.total > 0 ? ` (de ${datos.total})` : ""}
                  </th>
                </tr>
                <tr aria-current="true">
                  <td>{propia.posicion}</td>
                  <td>{propia.nombre} (vos)</td>
                  <td>{propia.exactos ?? "–"}</td>
                  <td>{propia.aciertos ?? "–"}</td>
                  <td>{propia.puntos}</td>
                </tr>
              </tbody>
            )}
          </table>
          <p className="prode-ranking__clave">Ex. = marcadores exactos · Ac. = aciertos de ganador o empate</p>
          </>
        )}
      </div>
    </div>
  );
}
