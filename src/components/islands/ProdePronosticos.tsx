import { useEffect, useState } from "react";
import { aviso, boton, etiquetaTarjeta, filaEquipo, golBoton, golCampo, grupoPasa, insignia, leyendaPasa, opcionPasa, radioPasa, resultadoCerrado, siglaEquipo, soloLectores, suave, tarjeta, texto, tituloEquipo } from "../prode/estilos";
import { desglosePuntos, ETIQUETA_ESTADO, formatearCierre, ladoPorMarcador, mensajeDeError, minutosHasta, parsearGol, sumarGol, textoPie, textoResultado, type EstadoPartido, type Lado } from "../prode/logica";

interface Pronostico {
  homeGoals: number;
  awayGoals: number;
  pasa: Lado | null;
}

interface Partido {
  id: string;
  faseEtiqueta: string | null;
  horario: { fecha: string; hora: string };
  local: { nombre: string };
  visitante: { nombre: string };
  cierre: string;
  estado: EstadoPartido;
  resultado: { local: number; visitante: number } | null;
  // Equipo que pasó (docs/40 R3); null si todavía no se sabe
  pasa: Lado | null;
  pronostico: Pronostico | null;
}

interface PuntosPartido {
  matchId: string;
  puntos: number;
  marcador: number;
  extra: number;
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

  const abiertos = partidos.filter((p) => p.estado === "abierto" && ahora < new Date(p.cierre).getTime()).length;
  const celda: React.CSSProperties = { padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 };
  const rot: React.CSSProperties = { font: "400 14px/1.1 var(--font-rotulo)", textTransform: "uppercase", letterSpacing: ".06em" };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: "16px 0" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", border: "2px solid var(--tinta)", background: "var(--celeste-claro)" }}>
        <div style={{ ...celda, borderRight: "1px solid var(--tinta)" }}>
          <span style={rot}>Puntaje</span>
          <p style={{ margin: 0, font: "400 28px/1 var(--font-titular)", textTransform: "uppercase" }}>Tus puntos: {puntos?.total ?? 0}</p>
        </div>
        <div style={celda}>
          <span style={rot}>Abiertos</span>
          <span style={{ font: "400 40px/1 var(--font-titular)" }}>{abiertos}</span>
        </div>
      </div>
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 14 }}>
        {partidos.map((p) => (
          <li key={p.id}>
            <TarjetaPartido partido={p} ahora={ahora} puntos={puntos?.porPartido.get(p.id)} />
          </li>
        ))}
      </ul>
      <p style={{ ...suave, margin: 0, textTransform: "uppercase", letterSpacing: ".06em" }}>Cada pronóstico cierra cuando empieza su partido.</p>
    </div>
  );
}

function TarjetaPartido({ partido, ahora, puntos }: { partido: Partido; ahora: number; puntos?: PuntosPartido }) {
  const [guardado, setGuardado] = useState(partido.pronostico);
  const [local, setLocal] = useState(partido.pronostico ? String(partido.pronostico.homeGoals) : "");
  const [visitante, setVisitante] = useState(partido.pronostico ? String(partido.pronostico.awayGoals) : "");
  const [pasa, setPasa] = useState<Lado | null>(partido.pronostico?.pasa ?? null);
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
    // Con empate hay que elegir quién pasa; con un ganador se deriva y no se manda (docs/40 R2)
    const pasaEnviado = homeGoals === awayGoals ? pasa : null;
    if (homeGoals === awayGoals && pasaEnviado === null) {
      setMensaje({ tipo: "error", texto: mensajeDeError(400, "falta_quien_pasa") });
      return;
    }
    setOcupado(true);
    setMensaje(null);
    try {
      const res = await fetch("/api/prode/pronosticos", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ matchId: partido.id, homeGoals, awayGoals, ...(pasaEnviado ? { pasa: pasaEnviado } : {}) }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        if (data.error === "pronostico_cerrado") setCerradoServidor(true);
        setMensaje({ tipo: "error", texto: mensajeDeError(res.status, data.error) });
        return;
      }
      setGuardado({ homeGoals, awayGoals, pasa: pasaEnviado });
      setMensaje({ tipo: "ok", texto: "Pronóstico guardado." });
    } catch {
      setMensaje({ tipo: "error", texto: "No se pudo guardar. Probá de nuevo." });
    } finally {
      setOcupado(false);
    }
  }

  // Lo que se está cargando: con empate pide elegir quién pasa; con un ganador, ese equipo pasa
  const lado = ladoPorMarcador(parsearGol(local), parsearGol(visitante));
  const pasaCargado = lado === "empate" ? pasa : null;
  const sinElegir = lado === "empate" && pasa === null;
  const sinCambios =
    guardado !== null && String(guardado.homeGoals) === local.trim() && String(guardado.awayGoals) === visitante.trim() && guardado.pasa === pasaCargado;
  const nombreDe = (l: Lado) => (l === "home" ? partido.local.nombre : partido.visitante.nombre);
  // Lo guardado, para un partido que ya no se edita
  const ladoGuardado = guardado ? ladoPorMarcador(guardado.homeGoals, guardado.awayGoals) : null;
  const pasaGuardado = ladoGuardado === "empate" ? guardado!.pasa : ladoGuardado;
  const desglose = puntos ? desglosePuntos(puntos.marcador, puntos.extra) : null;

  const cierraEn = estado === "abierto" ? minutosHasta(partido.cierre, ahora) : null;
  const urgente = cierraEn !== null && cierraEn <= 60;
  const filete = urgente ? "var(--amarillo)" : editable ? "var(--rojo)" : "var(--tinta)";
  const insigniaTxt = urgente ? `Cierra en ${cierraEn} min` : estado === "cerrado" ? "● Cerrado" : estado === "jugado" ? "Final" : null;
  const equipos = [
    { nombre: partido.local.nombre, sufijo: "l", valor: local, poner: setLocal, otro: visitante, ponerOtro: setVisitante, res: partido.resultado?.local },
    { nombre: partido.visitante.nombre, sufijo: "v", valor: visitante, poner: setVisitante, otro: local, ponerOtro: setLocal, res: partido.resultado?.visitante },
  ];

  return (
    <form noValidate onSubmit={guardar} aria-labelledby={`${id}-titulo`} style={{ ...tarjeta, borderTop: `4px solid ${filete}` }}>
      <div style={etiquetaTarjeta}>
        <span style={{ color: "var(--rojo)", fontWeight: 700 }}>{partido.faseEtiqueta ?? "Prode"}</span>
        <span style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", color: "var(--tinta-suave)" }}>
          <span>
            {estado === "abierto" ? `Cierra ${formatearCierre(partido.cierre)}` : `${partido.horario.fecha} ${partido.horario.hora} hs`} · {ETIQUETA_ESTADO[estado]}
          </span>
          {insigniaTxt && <span style={insignia(urgente ? "alerta" : estado === "jugado" ? "borde" : "oscuro")}>{insigniaTxt}</span>}
        </span>
      </div>
      <span id={`${id}-titulo`} style={soloLectores}>
        {partido.local.nombre} vs {partido.visitante.nombre}
      </span>
      {equipos.map((e) => (
        <div key={e.sufijo} style={filaEquipo}>
          <div role="img" aria-label={`Escudo de ${e.nombre}`} style={siglaEquipo}>{e.nombre.slice(0, 3).toUpperCase()}</div>
          <div style={tituloEquipo}>{e.nombre}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, flex: "none" }}>
            {editable && (
              <button type="button" aria-label={`Restar gol a ${e.nombre}`} onClick={() => sumarGol(-1, e.valor, e.otro, e.poner, e.ponerOtro)} style={golBoton}>−</button>
            )}
            <label htmlFor={`${id}-${e.sufijo}`} style={soloLectores}>Goles de {e.nombre}</label>
            <input
              id={`${id}-${e.sufijo}`}
              inputMode="numeric"
              autoComplete="off"
              placeholder="–"
              disabled={!editable}
              value={e.valor}
              onChange={(ev) => e.poner(ev.target.value)}
              style={editable ? golCampo : { ...golCampo, background: "var(--papel-2)" }}
            />
            {editable && (
              <button type="button" aria-label={`Sumar gol a ${e.nombre}`} onClick={() => sumarGol(1, e.valor, e.otro, e.poner, e.ponerOtro)} style={golBoton}>+</button>
            )}
            {estado === "jugado" && <div style={resultadoCerrado} aria-hidden="true">{e.res ?? "–"}</div>}
          </div>
        </div>
      ))}
      {editable && lado === "empate" && (
        <fieldset style={grupoPasa} disabled={ocupado}>
          <legend style={leyendaPasa}>¿Quién pasa?</legend>
          {(["home", "away"] as const).map((l) => (
            <label key={l} style={opcionPasa(pasa === l)}>
              <input type="radio" name={`${id}-pasa`} value={l} checked={pasa === l} onChange={() => { setPasa(l); setMensaje(null); }} style={radioPasa} />
              <span>{nombreDe(l)}</span>
            </label>
          ))}
        </fieldset>
      )}
      {editable && (lado === "home" || lado === "away") && <span style={suave}>Pasa: {nombreDe(lado)}</span>}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 10, borderTop: "1px solid var(--linea)", paddingTop: 12 }}>
        <span style={suave}>
          {textoPie({ editable, guardado: guardado !== null, sinCambios, sinElegir })}
        </span>
        {editable && (
          <button type="submit" className="tb-boton tb-boton--primario" disabled={ocupado || sinCambios || sinElegir} style={boton}>
            {ocupado ? "Guardando…" : guardado ? "Cambiar" : "Guardar"}
          </button>
        )}
      </div>
      {estado === "cerrado" && <span style={suave}>{guardado ? "Cerró el pronóstico" : "Cerró el pronóstico. No cargaste uno."}</span>}
      {!editable && guardado && (
        <span style={suave}>{pasaGuardado ? `En tu pronóstico pasa: ${nombreDe(pasaGuardado)}.` : "No elegiste quién pasa."}</span>
      )}
      {estado === "jugado" && (
        <span style={texto}>
          {textoResultado(partido.resultado, partido.pasa ? nombreDe(partido.pasa) : null)}
          {guardado ? "" : "No cargaste pronóstico. "}
          {puntos
            ? `Sumaste ${puntos.puntos} ${puntos.puntos === 1 ? "punto" : "puntos"}${desglose || puntos.exacto ? ` (${[desglose, puntos.exacto ? "resultado exacto" : null].filter(Boolean).join(", ")})` : ""}.`
            : ""}
        </span>
      )}
      <span role="status" aria-live="polite" style={aviso(mensaje?.tipo ?? "ok")}>
        {mensaje?.texto ?? ""}
      </span>
    </form>
  );
}
