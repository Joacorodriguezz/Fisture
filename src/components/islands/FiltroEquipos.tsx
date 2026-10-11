import { useMemo, useState } from "react";
import { chipStyle, normalizar } from "./estilos";

export interface EquipoItem {
  id: string;
  nombre: string;
  logo: string | null;
  sigla: string | null;
  ligaId: string;
  liga: string;
  siguiendo: boolean;
}

export interface LigaItem {
  id: string;
  nombre: string;
}

interface Props {
  equipos: EquipoItem[];
  // Si se pasa, muestra los chips para filtrar por liga
  ligas?: LigaItem[];
  // navegar: tarjetas que llevan a la ficha del equipo
  // seguir: filas con botón Seguir
  modo: "navegar" | "seguir";
  placeholder?: string;
  ligaInicial?: string;
}

function Escudo({ logo, nombre, sigla, size }: { logo: string | null; nombre: string; sigla: string | null; size: number }) {
  return (
    <span
      style={{
        flex: "none",
        width: size,
        height: size,
        background: "var(--crema-sobre-oscuro)",
        border: "2px solid var(--tinta)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 4,
        overflow: "hidden",
      }}
    >
      {logo ? (
        <img src={logo} alt={nombre} loading="lazy" style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
      ) : (
        <span style={{ font: "400 16px/1 var(--font-titular)" }}>{(sigla || nombre).slice(0, 3).toUpperCase()}</span>
      )}
    </span>
  );
}

export default function FiltroEquipos({ equipos, ligas, modo, placeholder = "Filtrá por nombre", ligaInicial = "" }: Props) {
  const [consulta, setConsulta] = useState("");
  const [liga, setLiga] = useState(ligaInicial);
  const [seguidos, setSeguidos] = useState<Set<string>>(
    () => new Set(equipos.filter((e) => e.siguiendo).map((e) => e.id))
  );
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const filtrados = useMemo(() => {
    const q = normalizar(consulta);
    return equipos.filter(
      (e) => (!liga || e.ligaId === liga) && (!q || normalizar(e.nombre).includes(q))
    );
  }, [equipos, consulta, liga]);

  async function seguir(teamId: string) {
    setOcupado(teamId);
    setError(null);
    try {
      const res = await fetch("/api/equipos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      if (!res.ok && res.status !== 409) throw new Error("follow failed");
      setSeguidos((prev) => new Set(prev).add(teamId));
    } catch {
      setError("No se pudo seguir el equipo. Probá de nuevo.");
    } finally {
      setOcupado(null);
    }
  }

  const sinResultados = filtrados.length === 0;
  const sufijoLiga = liga && ligas ? ligas.find((l) => l.id === liga)?.nombre : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {ligas && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <button type="button" onClick={() => setLiga("")} style={chipStyle(liga === "")}>
            Todas
          </button>
          {ligas.map((l) => (
            <button key={l.id} type="button" onClick={() => setLiga(l.id)} style={chipStyle(liga === l.id)}>
              {l.nombre}
            </button>
          ))}
        </div>
      )}

      <input
        type="search"
        value={consulta}
        onChange={(e) => setConsulta(e.target.value)}
        placeholder={placeholder}
        aria-label="Buscar equipos"
        style={{
          width: "100%",
          padding: "14px 16px",
          background: "var(--papel)",
          color: "var(--tinta)",
          border: "2px solid var(--tinta)",
          borderRadius: 2,
          font: "600 20px/24px var(--font-rotulo)",
          outline: "none",
        }}
      />

      {sufijoLiga && (
        <span style={{ font: "700 13px/16px var(--font-rotulo)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--tinta-suave)" }}>
          Mostrando: {sufijoLiga}
        </span>
      )}

      {error && <p style={{ margin: 0, color: "var(--rojo)", font: "600 15px/20px var(--font-rotulo)" }}>{error}</p>}

      {modo === "navegar" ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,170px),1fr))", gap: 12 }}>
          {filtrados.map((e) => {
            const siguiendo = seguidos.has(e.id);
            return (
              <a
                key={e.id}
                href={`/equipos/${e.id}`}
                style={{
                  cursor: "pointer",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 10,
                  padding: "18px 10px 14px",
                  background: siguiendo ? "var(--papel-2)" : "var(--papel)",
                  border: `2px solid ${siguiendo ? "var(--rojo)" : "var(--linea)"}`,
                  textAlign: "center",
                  color: "var(--tinta)",
                  textDecoration: "none",
                }}
              >
                <Escudo logo={e.logo} nombre={e.nombre} sigla={e.sigla} size={72} />
                <span style={{ font: "700 16px/19px var(--font-rotulo)", letterSpacing: ".02em", textTransform: "uppercase" }}>
                  {e.nombre}
                </span>
                <span
                  style={{
                    font: "700 12px/16px var(--font-rotulo)",
                    letterSpacing: ".06em",
                    textTransform: "uppercase",
                    color: siguiendo ? "var(--rojo)" : "var(--tinta-suave)",
                  }}
                >
                  {siguiendo ? "■ Siguiendo" : "Ver partidos"}
                </span>
              </a>
            );
          })}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {filtrados.map((e) => {
            const siguiendo = seguidos.has(e.id);
            return (
              <div
                key={e.id}
                style={{ display: "flex", alignItems: "center", gap: 16, padding: 12, borderBottom: "1px solid var(--linea)" }}
              >
                <Escudo logo={e.logo} nombre={e.nombre} sigla={e.sigla} size={44} />
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>
                  <span style={{ font: "700 17px/20px var(--font-rotulo)", letterSpacing: ".02em", textTransform: "uppercase" }}>
                    {e.nombre}
                  </span>
                  <span style={{ font: "500 14px/18px var(--font-rotulo)", color: "var(--tinta-suave)" }}>{e.liga}</span>
                </div>
                {siguiendo ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 8, font: "700 14px/18px var(--font-rotulo)", letterSpacing: ".06em", textTransform: "uppercase", color: "var(--rojo)" }}>
                    <span style={{ width: 12, height: 12, background: "var(--rojo)" }} />
                    Siguiendo
                  </span>
                ) : (
                  <button
                    type="button"
                    className="tb-boton"
                    disabled={ocupado === e.id}
                    onClick={() => seguir(e.id)}
                  >
                    {ocupado === e.id ? "Agregando…" : "Seguir"}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {sinResultados && (
        <p style={{ margin: 0, padding: "24px 12px", font: "400 17px/27px var(--font-texto)", color: "var(--tinta-suave)" }}>
          {consulta.trim() ? `Ningún equipo coincide con «${consulta.trim()}».` : "No hay equipos para mostrar."}
        </p>
      )}
    </div>
  );
}
