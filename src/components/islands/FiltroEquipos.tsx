import { memo, useDeferredValue, useMemo, useState } from "react";
import { normalizar } from "./estilos";
import { irALogin } from "../../lib/auth/client";

export interface EquipoItem {
  id: string;
  nombre: string;
  logo: string | null;
  sigla: string | null;
  // Competencias que juega el equipo (su liga y las copas)
  ligaIds: string[];
  // Nombre de su liga de origen
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
  // Visitante sin sesión: seguir un equipo pide iniciar sesión
  anonimo?: boolean;
}

const Escudo = memo(function Escudo({ logo, nombre, sigla, size }: { logo: string | null; nombre: string; sigla: string | null; size: number }) {
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
        <img src={logo} alt={nombre} loading="lazy" decoding="async" style={{ width: "100%", height: "100%", objectFit: "contain", display: "block" }} />
      ) : (
        <span style={{ font: "400 16px/1 var(--font-titular)" }}>{(sigla || nombre).slice(0, 3).toUpperCase()}</span>
      )}
    </span>
  );
});

export default function FiltroEquipos({ equipos, ligas, modo, placeholder = "Filtrá por nombre", ligaInicial = "", anonimo = false }: Props) {
  const [consulta, setConsulta] = useState("");
  const [liga, setLiga] = useState(ligaInicial);
  const [seguidos, setSeguidos] = useState<Set<string>>(
    () => new Set(equipos.filter((e) => e.siguiendo).map((e) => e.id))
  );
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // La lista puede tener cientos de equipos: el input responde al instante y el filtrado va diferido
  const consultaDiferida = useDeferredValue(consulta);
  const filtrados = useMemo(() => {
    const q = normalizar(consultaDiferida);
    return equipos.filter(
      (e) => (!liga || e.ligaIds.includes(liga)) && (!q || normalizar(e.nombre).includes(q))
    );
  }, [equipos, consultaDiferida, liga]);

  async function seguir(teamId: string) {
    if (anonimo) return irALogin();
    setOcupado(teamId);
    setError(null);
    try {
      const res = await fetch("/api/equipos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teamId }),
      });
      if (res.status === 401) return irALogin();
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
          <button type="button" aria-pressed={liga === ""} onClick={() => setLiga("")} className={liga === "" ? "tb-chip tb-chip--activo" : "tb-chip"}>
            Todas
          </button>
          {ligas.map((l) => (
            <button key={l.id} type="button" aria-pressed={liga === l.id} onClick={() => setLiga(l.id)} className={liga === l.id ? "tb-chip tb-chip--activo" : "tb-chip"}>
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
        className="tb-buscador"
      />

      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }} aria-live="polite">
        <span className="tb-meta">
          {filtrados.length} {filtrados.length === 1 ? "equipo" : "equipos"}
          {sufijoLiga ? ` · ${sufijoLiga}` : ""}
        </span>
        {(consulta || liga) && (
          <button
            type="button"
            className="tb-link-boton"
            onClick={() => {
              setConsulta("");
              setLiga("");
            }}
          >
            Limpiar filtros
          </button>
        )}
      </div>

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
                    font: "700 13px/16px var(--font-rotulo)",
                    letterSpacing: ".06em",
                    textTransform: "uppercase",
                    color: siguiendo ? "var(--rojo)" : "var(--tinta-suave)",
                  }}
                >
                  {siguiendo ? "✓ Siguiendo" : "Ver equipo"}
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
                    ✓ Siguiendo
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
