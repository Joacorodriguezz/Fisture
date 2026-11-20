import { useEffect, useState } from "react";
import { suave, texto } from "../prode/estilos";
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
  const [errorPuntos, setErrorPuntos] = useState(false);
  const [intentoPuntos, setIntentoPuntos] = useState(0);
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setAhora(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const rp = await fetch("/api/prode/pronosticos");
        const dp = (await rp.json().catch(() => ({}))) as { partidos?: Partido[]; error?: string };
        if (!rp.ok || !Array.isArray(dp.partidos)) {
          if (vivo) setError(mensajeDeError(rp.status, dp.error));
          return;
        }
        if (vivo) setPartidos(dp.partidos);
      } catch {
        if (vivo) setError("No se pudo cargar el prode. Probá de nuevo.");
      }
    })();
    return () => {
      vivo = false;
    };
  }, []);

  useEffect(() => {
    let vivo = true;
    setErrorPuntos(false);
    (async () => {
      try {
        const res = await fetch("/api/prode/mis-puntos");
        if (!res.ok) throw new Error();
        const datos = await res.json() as { puntos: number; partidos: PuntosPartido[] };
        if (!Array.isArray(datos.partidos) || typeof datos.puntos !== "number") throw new Error();
        if (vivo) setPuntos({ total: datos.puntos, porPartido: new Map(datos.partidos.map((p) => [p.matchId, p])) });
      } catch {
        if (vivo) setErrorPuntos(true);
      }
    })();
    return () => { vivo = false; };
  }, [intentoPuntos]);

  if (error) {
    return (
      <p role="alert" className="prode-estado-vacio">
        {error}
      </p>
    );
  }
  if (!partidos) return <p role="status" className="prode-estado-vacio">Cargando partidos…</p>;
  const fechaArgentina = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Argentina/Buenos_Aires" });
  const hoy = fechaArgentina.format(ahora);
  const diaDe = (p: Partido) => fechaArgentina.format(new Date(p.cierre));
  const fechaSiguiente = partidos.map(diaDe).filter((dia) => dia > hoy).sort()[0];
  const abierto = (p: Partido) => p.estado === "abierto" && Date.parse(p.cierre) > ahora;
  const partidosHoy = partidos.filter((p) => diaDe(p) === hoy);
  partidosHoy.sort((a, b) => Number(abierto(b)) - Number(abierto(a)));
  const bloques = [
    { titulo: "Hoy", filas: partidosHoy, mostrarFecha: true },
    { titulo: "Próxima fecha", filas: partidos.filter((p) => diaDe(p) === fechaSiguiente), mostrarFecha: true },
    { titulo: "Próximos partidos", filas: partidos.filter((p) => fechaSiguiente && diaDe(p) > fechaSiguiente), mostrarFecha: false },
    { titulo: "Partidos anteriores", filas: partidos.filter((p) => diaDe(p) < hoy).reverse(), mostrarFecha: false },
  ];

  return (
    <div>
      {errorPuntos && <div className="prode-ranking__filtro"><span role="status">No se pudieron cargar tus puntos.</span><button type="button" className="tb-boton" onClick={() => setIntentoPuntos((n) => n + 1)}>Reintentar</button></div>}
      {puntos && (
        <p className="prode-puntos">Tus puntos: <strong>{puntos.total}</strong></p>
      )}
      {bloques.filter(({ titulo, filas }) => titulo === "Hoy" || filas.length > 0).map(({ titulo, filas, mostrarFecha }) => (
        <section key={titulo}>
          <h3 className="prode-jornada">{titulo}<span>{mostrarFecha ? filas[0]?.horario.fecha : filas.length}</span></h3>
          {filas.length === 0 && <p className="prode-estado-vacio">{fechaSiguiente ? "Hoy no hay partidos del prode." : "Hoy no hay partidos y todavía no se programó la próxima fecha."}</p>}
          {filas.length > 0 && <ul className="prode-partidos">
            {filas.map((p) => (
              <li key={p.id}>
                <TarjetaPartido partido={p} ahora={ahora} puntos={puntos?.porPartido.get(p.id)} />
              </li>
            ))}
          </ul>}
        </section>
      ))}
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
      window.dispatchEvent(new Event("prode:pronostico-guardado"));
      setMensaje({ tipo: "ok", texto: "Pronóstico guardado." });
    } catch {
      setMensaje({ tipo: "error", texto: "No se pudo guardar. Probá de nuevo." });
    } finally {
      setOcupado(false);
    }
  }

  const sinCambios = guardado !== null && String(guardado.homeGoals) === local.trim() && String(guardado.awayGoals) === visitante.trim();

  return (
    <form noValidate onSubmit={guardar} aria-label={`${partido.local.nombre} vs ${partido.visitante.nombre}`} className="prode-partido" data-estado={estado}>
      <div className="prode-partido__meta">
        <span>{partido.faseEtiqueta ?? "Prode"}</span>
        <span>
          {estado === "abierto" ? `Cierra ${formatearCierre(partido.cierre)}` : `${partido.horario.fecha} ${partido.horario.hora} hs`}
        </span>
        <span className="prode-partido__estado">{ETIQUETA_ESTADO[estado]}</span>
      </div>
      <div className="prode-partido__tablero">
        <label className="prode-partido__equipo">
          <span>{partido.local.nombre}</span>
          <input id={`${id}-l`} className="prode-partido__gol" aria-label={`Goles de ${partido.local.nombre}`} inputMode="numeric" autoComplete="off" placeholder="–" disabled={!editable || ocupado} value={local} onChange={(e) => { setLocal(e.target.value); setMensaje(null); }} />
        </label>
        <label className="prode-partido__equipo">
          <span>{partido.visitante.nombre}</span>
          <input id={`${id}-v`} className="prode-partido__gol" aria-label={`Goles de ${partido.visitante.nombre}`} inputMode="numeric" autoComplete="off" placeholder="–" disabled={!editable || ocupado} value={visitante} onChange={(e) => { setVisitante(e.target.value); setMensaje(null); }} />
        </label>
      </div>
      {estado === "cerrado" && <span style={suave}>{guardado ? "Cerró el pronóstico" : "Cerró el pronóstico. No cargaste uno."}</span>}
      {estado === "cerrado" && !partido.resultado && <span style={suave}>Resultado pendiente de confirmación.</span>}
      {estado === "jugado" && (
        <div className="prode-partido__resultado" style={texto}>
          {partido.resultado && <strong>Resultado: {partido.resultado.local} - {partido.resultado.visitante}.</strong>}
          {!guardado && <span>No cargaste pronóstico.</span>}
          {puntos && <span>Sumaste {puntos.puntos} {puntos.puntos === 1 ? "punto" : "puntos"}{puntos.exacto ? " (resultado exacto)" : ""}.</span>}
        </div>
      )}
      <div className="prode-partido__pie">
        <span role="status" aria-live="polite" data-tipo={mensaje?.tipo}>
          {mensaje?.texto ?? (editable && guardado ? sinCambios ? "Marcador guardado." : "Cambios sin guardar." : "")}
        </span>
        {editable && (
          <button type="submit" className="tb-boton tb-boton--primario" disabled={ocupado || sinCambios}>
            {ocupado ? "Guardando…" : guardado ? "Cambiar" : "Guardar"}
          </button>
        )}
      </div>
    </form>
  );
}
