import { useEffect, useMemo, useRef, useState } from "react";
import { irALogin } from "../../../lib/auth/client";
import { urlEscudo } from "../../../lib/escudo";

// Carga de pronósticos del prode (docs/37 D13): partidos por día, goles con − / + de 44 px, un solo
// «Guardar» fijo con el contador de cambios y aviso al salir con cambios sin guardar. El cierre lo decide
// el servidor; acá las filas se bloquean solas al llegar la hora para no invitar a cargar tarde.

export interface EquipoVista {
  nombre: string;
  sigla: string | null;
  logo: string | null;
}

export interface PartidoVista {
  id: string;
  // ISO: hora de inicio (= cierre del pronóstico)
  inicio: string;
  // Textos ya formateados en hora argentina por el servidor (evita diferencias de hidratación)
  dia: string;
  hora: string;
  ronda: string | null;
  local: EquipoVista;
  visitante: EquipoVista;
  pronostico: { local: number; visitante: number } | null;
}

interface Props {
  partidos: PartidoVista[];
}

type Valor = { local: string; visitante: string };
type Lado = keyof Valor;

const MAX_GOLES = 20;
const POR_REQUEST = 40;
const AVISO_CIERRE_MS = 3 * 60 * 60 * 1000;

const MENSAJES_RECHAZO: Record<string, string> = {
  cerrado: "Ya empezó: este pronóstico no se guardó.",
  invalido: "Revisá los goles: van de 0 a 20.",
  inexistente: "Este partido ya no está en el fixture.",
};

const aTexto = (p: PartidoVista["pronostico"]): Valor => (p ? { local: String(p.local), visitante: String(p.visitante) } : { local: "", visitante: "" });

function Escudo({ equipo }: { equipo: EquipoVista }) {
  return (
    <span className="pr-escudo" aria-hidden="true">
      {equipo.logo ? <img src={urlEscudo(equipo.logo, 32)} alt="" loading="lazy" decoding="async" /> : <span>{(equipo.sigla || equipo.nombre).slice(0, 3).toUpperCase()}</span>}
    </span>
  );
}

function faltaParaCierre(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `Cierra en ${min} min`;
  const h = Math.floor(min / 60);
  return `Cierra en ${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

export default function CargarPronosticos({ partidos }: Props) {
  const [valores, setValores] = useState<Record<string, Valor>>(() => Object.fromEntries(partidos.map((p) => [p.id, aTexto(p.pronostico)])));
  const [guardados, setGuardados] = useState<Record<string, Valor>>(() => Object.fromEntries(partidos.map((p) => [p.id, aTexto(p.pronostico)])));
  const [errores, setErrores] = useState<Record<string, string>>({});
  const [enviando, setEnviando] = useState(false);
  const [mensaje, setMensaje] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);
  // null hasta montar: el HTML del servidor no depende del reloj del navegador
  const [ahora, setAhora] = useState<number | null>(null);
  const valoresRef = useRef(valores);
  valoresRef.current = valores;

  useEffect(() => {
    setAhora(Date.now());
    const id = window.setInterval(() => setAhora(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);

  const cerrado = (p: PartidoVista) => ahora !== null && ahora >= Date.parse(p.inicio);
  const cambiado = (id: string) => valores[id].local !== guardados[id].local || valores[id].visitante !== guardados[id].visitante;
  const pendientes = partidos.filter((p) => cambiado(p.id) && !cerrado(p));

  // Aviso del navegador al salir con cambios sin guardar
  const hayCambios = pendientes.length > 0;
  useEffect(() => {
    if (!hayCambios) return;
    const avisar = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", avisar);
    return () => window.removeEventListener("beforeunload", avisar);
  }, [hayCambios]);

  const dias = useMemo(() => {
    const grupos: { dia: string; partidos: PartidoVista[] }[] = [];
    for (const p of partidos) {
      const ultimo = grupos[grupos.length - 1];
      if (ultimo && ultimo.dia === p.dia) ultimo.partidos.push(p);
      else grupos.push({ dia: p.dia, partidos: [p] });
    }
    return grupos;
  }, [partidos]);

  function cambiar(id: string, lado: Lado, texto: string) {
    const limpio = texto.replace(/\D/g, "").slice(0, 2);
    const numero = limpio === "" ? "" : String(Math.min(MAX_GOLES, Number(limpio)));
    setValores((prev) => {
      const actual = prev[id];
      const otro: Lado = lado === "local" ? "visitante" : "local";
      // Un pronóstico necesita los dos goles: al cargar uno, el otro arranca en 0
      const siguiente = { ...actual, [lado]: numero };
      if (numero !== "" && actual[otro] === "") siguiente[otro] = "0";
      return { ...prev, [id]: siguiente };
    });
    setErrores(({ [id]: _, ...resto }) => resto);
    setMensaje(null);
  }

  function paso(id: string, lado: Lado, delta: 1 | -1) {
    const actual = valoresRef.current[id][lado];
    const base = actual === "" ? (delta > 0 ? 0 : 1) : Number(actual);
    cambiar(id, lado, String(Math.max(0, Math.min(MAX_GOLES, base + delta))));
  }

  async function guardar(e?: React.FormEvent) {
    e?.preventDefault();
    if (enviando) return;
    const nuevosErrores: Record<string, string> = {};
    const lote: { partidoId: string; local: number | null; visitante: number | null }[] = [];
    for (const p of pendientes) {
      const v = valores[p.id];
      if (v.local === "" && v.visitante === "") lote.push({ partidoId: p.id, local: null, visitante: null });
      else if (v.local === "" || v.visitante === "") nuevosErrores[p.id] = "Completá los dos goles.";
      else lote.push({ partidoId: p.id, local: Number(v.local), visitante: Number(v.visitante) });
    }
    setErrores(nuevosErrores);
    if (lote.length === 0) {
      setMensaje({ tipo: "error", texto: "Completá los dos goles de cada partido que cambiaste." });
      return;
    }

    setEnviando(true);
    setMensaje(null);
    let guardadosOk = 0;
    try {
      for (let i = 0; i < lote.length; i += POR_REQUEST) {
        const res = await fetch("/api/prode/pronosticos", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pronosticos: lote.slice(i, i + POR_REQUEST) }),
        });
        if (res.status === 401) return irALogin();
        if (res.status === 429) throw new Error("rate");
        if (!res.ok) throw new Error("http");
        const r = (await res.json()) as {
          guardados: { partidoId: string; local: number; visitante: number }[];
          borrados: string[];
          rechazados: { partidoId: string; motivo: string }[];
        };
        setGuardados((prev) => {
          const sig = { ...prev };
          for (const g of r.guardados) sig[g.partidoId] = { local: String(g.local), visitante: String(g.visitante) };
          for (const id of r.borrados) sig[id] = { local: "", visitante: "" };
          return sig;
        });
        guardadosOk += r.guardados.length + r.borrados.length;
        if (r.rechazados.length > 0) {
          setErrores((prev) => ({ ...prev, ...Object.fromEntries(r.rechazados.map((x) => [x.partidoId, MENSAJES_RECHAZO[x.motivo] ?? "No se guardó."])) }));
        }
      }
      const fallidos = Object.keys(nuevosErrores).length;
      setMensaje(
        guardadosOk > 0
          ? { tipo: "ok", texto: `${guardadosOk === 1 ? "Guardamos 1 pronóstico" : `Guardamos ${guardadosOk} pronósticos`}.${fallidos ? " Revisá los marcados." : ""}` }
          : { tipo: "error", texto: "No se guardó ningún pronóstico. Revisá los marcados." }
      );
    } catch (err) {
      setMensaje({
        tipo: "error",
        texto: (err as Error).message === "rate" ? "Demasiados intentos seguidos. Esperá un minuto y probá de nuevo." : "No se pudo guardar. Revisá la conexión y probá de nuevo: lo que cargaste sigue acá.",
      });
    } finally {
      setEnviando(false);
    }
  }

  return (
    <form className="pr-form" onSubmit={guardar} noValidate>
      {dias.map(({ dia, partidos: delDia }) => (
        <section key={dia} aria-label={dia}>
          <h3 className="tb-barra tb-barra--tinta pr-dia">
            <span>{dia}</span>
            <span className="tb-barra__extra">{delDia.length === 1 ? "1 partido" : `${delDia.length} partidos`}</span>
          </h3>
          <ul className="pr-lista">
            {delDia.map((p) => {
              const v = valores[p.id];
              const bloqueado = cerrado(p) || enviando;
              const error = errores[p.id];
              const esCambio = cambiado(p.id) && !cerrado(p);
              const tieneGuardado = guardados[p.id].local !== "";
              const falta = ahora !== null ? Date.parse(p.inicio) - ahora : null;
              return (
                <li key={p.id}>
                  <fieldset className={`pr-partido${esCambio ? " pr-partido--cambiado" : ""}`} aria-describedby={`estado-${p.id}`}>
                    <legend>
                      {p.hora} hs{p.ronda ? ` · ${p.ronda}` : ""}
                      <span className="pr-oculto">: {p.local.nombre} contra {p.visitante.nombre}</span>
                    </legend>
                    <div className="pr-cruce">
                    {(["local", "visitante"] as const).map((lado) => {
                      const equipo = p[lado];
                      const valor = v[lado];
                      return (
                        <div className={`pr-fila pr-fila--${lado}`} key={lado}>
                          <span className="pr-equipo">
                            <Escudo equipo={equipo} />
                            <span id={`eq-${p.id}-${lado}`}>{equipo.nombre}</span>
                          </span>
                          <span className="pr-goles">
                            <button type="button" aria-label={`Restar un gol a ${equipo.nombre}`} disabled={bloqueado || valor === "0"} onClick={() => paso(p.id, lado, -1)}>
                              −
                            </button>
                            <input
                              type="text"
                              inputMode="numeric"
                              pattern="[0-9]*"
                              autoComplete="off"
                              maxLength={2}
                              placeholder="–"
                              aria-label={`Goles de ${equipo.nombre}`}
                              value={valor}
                              disabled={bloqueado}
                              aria-invalid={error ? true : undefined}
                              onChange={(e) => cambiar(p.id, lado, e.target.value)}
                              onFocus={(e) => e.target.select()}
                            />
                            <button type="button" aria-label={`Sumar un gol a ${equipo.nombre}`} disabled={bloqueado || valor === String(MAX_GOLES)} onClick={() => paso(p.id, lado, 1)}>
                              +
                            </button>
                          </span>
                        </div>
                      );
                    })}
                    </div>
                    <p className="pr-pie-partido" id={`estado-${p.id}`}>
                      {cerrado(p) ? (
                        <span>Cerrado: ya empezó</span>
                      ) : (
                        <>
                          <span>Cierra {p.hora} hs</span>
                          {falta !== null && falta < AVISO_CIERRE_MS && <span className="pr-pronto">{faltaParaCierre(falta)}</span>}
                        </>
                      )}
                      {error ? (
                        <span className="pr-estado--error" role="alert">{error}</span>
                      ) : esCambio ? (
                        <span className="pr-estado--cambiado">Sin guardar</span>
                      ) : tieneGuardado ? (
                        <span className="pr-estado--guardado">✓ Guardado</span>
                      ) : (
                        <span>Sin pronóstico</span>
                      )}
                    </p>
                  </fieldset>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <div className={`pr-barra-guardar${pendientes.length > 0 || enviando || mensaje?.tipo === "error" ? " pr-barra-guardar--fija" : ""}`}>
        <p role="status" aria-live="polite">
          {mensaje && mensaje.tipo === "ok"
            ? mensaje.texto
            : pendientes.length === 0
              ? "Todo guardado"
              : pendientes.length === 1
                ? "1 cambio sin guardar"
                : `${pendientes.length} cambios sin guardar`}
        </p>
        <button type="submit" className="tb-boton tb-boton--primario" disabled={enviando || pendientes.length === 0}>
          {enviando ? "Guardando…" : "Guardar pronósticos"}
        </button>
        {mensaje?.tipo === "error" && (
          <p className="tb-error" role="alert" style={{ flexBasis: "100%" }}>
            {mensaje.texto}
          </p>
        )}
      </div>
    </form>
  );
}
