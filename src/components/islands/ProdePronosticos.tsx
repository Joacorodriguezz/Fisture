import { useEffect, useState } from "react";
import { aviso, boton, campo, fila, rotulo, soloLectores, suave, texto } from "../prode/estilos";
import { ETIQUETA_ESTADO, formatearCierre, mensajeDeError, parsearGol, type EstadoPartido } from "../prode/logica";

interface Partido {
  id: string;
  faseEtiqueta: string | null;
  horario: { fecha: string; hora: string };
  local: { nombre: string };
  visitante: { nombre: string };
  cierre: string;
  estado: EstadoPartido;
  resultado: { local: number; visitante: number } | null;
  pronostico: { homeGoals: number; awayGoals: number } | null;
}

interface PuntosPartido {
  matchId: string;
  puntos: number;
  exacto: boolean;
  acierto: boolean;
}

interface Aviso {
  tipo: "ok" | "error";
  texto: string;
}

// Pronósticos del prode: GET/PUT /api/prode/pronosticos y puntos de GET /api/prode/mis-puntos.
// El servidor decide el cierre con su propia hora; acá solo se deshabilita para no tentar al usuario.
export default function ProdePronosticos() {
  const [partidos, setPartidos] = useState<Partido[] | null>(null);
  const [puntos, setPuntos] = useState<{ total: number; porPartido: Map<string, PuntosPartido> } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const [rp, rm] = await Promise.all([fetch("/api/prode/pronosticos"), fetch("/api/prode/mis-puntos")]);
        const dp = (await rp.json().catch(() => ({}))) as { partidos?: Partido[]; error?: string };
        if (!rp.ok || !Array.isArray(dp.partidos)) {
          if (vivo) setError(mensajeDeError(rp.status, dp.error));
          return;
        }
        if (vivo) setPartidos(dp.partidos);
        if (rm.ok) {
          const dm = (await rm.json().catch(() => null)) as { puntos?: number; partidos?: PuntosPartido[] } | null;
          if (vivo && dm && Array.isArray(dm.partidos)) {
            setPuntos({ total: dm.puntos ?? 0, porPartido: new Map(dm.partidos.map((p) => [p.matchId, p])) });
          }
        }
      } catch {
        if (vivo) setError("No se pudo cargar el prode. Probá de nuevo.");
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  if (error) {
    return (
      <p role="alert" style={{ ...texto, padding: 16, color: "var(--alerta, #b00020)" }}>
        {error}
      </p>
    );
  }
  if (!partidos) return <p role="status" style={{ ...suave, padding: 16 }}>Cargando partidos…</p>;
  if (partidos.length === 0) return <p style={{ ...suave, padding: 16 }}>Todavía no hay partidos del prode. Volvé pronto.</p>;

  return (
    <div>
      {puntos && (
        <p style={{ ...rotulo, padding: "12px", borderBottom: "1px solid var(--linea)" }}>Tus puntos: {puntos.total}</p>
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {partidos.map((p) => (
          <li key={p.id}>
            <TarjetaPartido partido={p} ahora={ahora} puntos={puntos?.porPartido.get(p.id)} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function TarjetaPartido({ partido, ahora, puntos }: { partido: Partido; ahora: number; puntos?: PuntosPartido }) {
  const [guardado, setGuardado] = useState(partido.pronostico);
  const [local, setLocal] = useState(partido.pronostico ? String(partido.pronostico.homeGoals) : "");
  const [visitante, setVisitante] = useState(partido.pronostico ? String(partido.pronostico.awayGoals) : "");
  const [cerradoServidor, setCerradoServidor] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [mensaje, setMensaje] = useState<Aviso | null>(null);

  const estado: EstadoPartido =
    partido.estado === "jugado" ? "jugado" : partido.estado === "cerrado" || cerradoServidor || ahora >= new Date(partido.cierre).getTime() ? "cerrado" : "abierto";
  const editable = estado === "abierto";
  const id = `prode-${partido.id}`;

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (ocupado || !editable) return;
    const homeGoals = parsearGol(local);
    const awayGoals = parsearGol(visitante);
    if (homeGoals === null || awayGoals === null) {
      setMensaje({ tipo: "error", texto: mensajeDeError(400, "marcador_invalido") });
      return;
    }
    setOcupado(true);
    setMensaje(null);
    try {
      const res = await fetch("/api/prode/pronosticos", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId: partido.id, homeGoals, awayGoals }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        if (data.error === "pronostico_cerrado") setCerradoServidor(true);
        setMensaje({ tipo: "error", texto: mensajeDeError(res.status, data.error) });
        return;
      }
      setGuardado({ homeGoals, awayGoals });
      setMensaje({ tipo: "ok", texto: "Pronóstico guardado." });
    } catch {
      setMensaje({ tipo: "error", texto: "No se pudo guardar. Probá de nuevo." });
    } finally {
      setOcupado(false);
    }
  }

  const sinCambios = guardado !== null && String(guardado.homeGoals) === local.trim() && String(guardado.awayGoals) === visitante.trim();

  return (
    <form noValidate onSubmit={guardar} aria-labelledby={`${id}-titulo`} style={fila}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", ...suave }}>
        <span>{partido.faseEtiqueta ?? "Prode"}</span>
        <span>
          {estado === "abierto" ? `Cierra ${formatearCierre(partido.cierre)}` : `${partido.horario.fecha} ${partido.horario.hora} hs`} · {ETIQUETA_ESTADO[estado]}
        </span>
      </div>
      <span id={`${id}-titulo`} style={rotulo}>
        {partido.local.nombre} vs {partido.visitante.nombre}
      </span>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <label htmlFor={`${id}-l`} style={soloLectores}>Goles de {partido.local.nombre}</label>
        <input id={`${id}-l`} inputMode="numeric" autoComplete="off" disabled={!editable} value={local} onChange={(e) => setLocal(e.target.value)} style={{ ...campo, width: 64, textAlign: "center" }} />
        <span aria-hidden="true">-</span>
        <label htmlFor={`${id}-v`} style={soloLectores}>Goles de {partido.visitante.nombre}</label>
        <input id={`${id}-v`} inputMode="numeric" autoComplete="off" disabled={!editable} value={visitante} onChange={(e) => setVisitante(e.target.value)} style={{ ...campo, width: 64, textAlign: "center" }} />
        {editable && (
          <button type="submit" className="tb-boton tb-boton--primario" disabled={ocupado || sinCambios} style={boton}>
            {ocupado ? "Guardando…" : guardado ? "Cambiar" : "Guardar"}
          </button>
        )}
      </div>
      {estado === "cerrado" && <span style={suave}>{guardado ? "Cerró el pronóstico" : "Cerró el pronóstico. No cargaste uno."}</span>}
      {estado === "jugado" && (
        <span style={texto}>
          {partido.resultado ? `Resultado: ${partido.resultado.local} - ${partido.resultado.visitante}. ` : ""}
          {guardado ? "" : "No cargaste pronóstico. "}
          {puntos ? `Sumaste ${puntos.puntos} ${puntos.puntos === 1 ? "punto" : "puntos"}${puntos.exacto ? " (resultado exacto)" : ""}.` : ""}
        </span>
      )}
      <span role="status" aria-live="polite" style={aviso(mensaje?.tipo ?? "ok")}>
        {mensaje?.texto ?? ""}
      </span>
    </form>
  );
}
