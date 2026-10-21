import { useEffect, useRef, useState } from "react";
import SincronizarPartido from "./SincronizarPartido";

export interface DiaTira {
  iso: string;
  semana: string;
  numero: string;
  cantidad: number;
  esHoy: boolean;
  activo: boolean;
  href: string;
}

export interface EquipoVista {
  nombre: string;
  sigla: string | null;
  logo: string | null;
}

export interface PartidoVista {
  id: string;
  hora: string;
  local: EquipoVista;
  visitante: EquipoVista;
  meta: string;
  mio: boolean;
  status: string | null;
  errorMessage: string | null;
}

export interface GrupoVista {
  id: string;
  nombre: string;
  items: PartidoVista[];
}

interface Props {
  dias: DiaTira[];
  grupos: GrupoVista[];
  anonimo: boolean;
  soloMios: boolean;
  hrefTodos: string;
  hrefMios: string;
  // Hay partidos ese día pero ninguno de tus equipos juega
  sinMios: boolean;
}

// Alto del bloque pegajoso (tira de días 76 + filtros 56 + bordes), igual que .hm-sticky
const ALTO_STICKY = 134;
const CLAVE_CERRADAS = "fisture:hoy:cerradas";

function Escudo({ equipo }: { equipo: EquipoVista }) {
  const iniciales = (equipo.sigla || equipo.nombre).slice(0, 3).toUpperCase();
  return (
    <span className="hm-escudo">
      {equipo.logo ? <img src={equipo.logo} alt={equipo.nombre} loading="lazy" decoding="async" /> : iniciales}
    </span>
  );
}

export default function HoyMovil({ dias, grupos, anonimo, soloMios, hrefTodos, hrefMios, sinMios }: Props) {
  const [cerradas, setCerradas] = useState<Set<string>>(new Set());
  const [visible, setVisible] = useState<string>(grupos[0]?.id ?? "");
  const tira = useRef<HTMLDivElement>(null);
  const refs = useRef(new Map<string, HTMLElement>());

  // Que el día elegido se vea en la tira
  useEffect(() => {
    const activo = tira.current?.querySelector<HTMLElement>('[aria-current="date"]');
    if (tira.current && activo) {
      tira.current.scrollLeft = activo.offsetLeft - tira.current.clientWidth / 2 + activo.clientWidth / 2;
    }
  }, []);

  // Ligas cerradas: se recuerdan en este navegador (si hay storage)
  useEffect(() => {
    try {
      const guardado = JSON.parse(localStorage.getItem(CLAVE_CERRADAS) ?? "[]") as string[];
      setCerradas(new Set(guardado));
    } catch {
      // Sin storage, arrancan todas abiertas
    }
  }, []);

  function guardar(siguiente: Set<string>) {
    setCerradas(siguiente);
    try {
      localStorage.setItem(CLAVE_CERRADAS, JSON.stringify([...siguiente]));
    } catch {
      // Sin storage el estado vive solo en la página
    }
  }

  function alternar(id: string) {
    const s = new Set(cerradas);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    guardar(s);
  }

  // Scroll-spy: la liga visible es el último grupo cuyo borde superior ya llegó a la barra pegajosa
  useEffect(() => {
    function onScroll() {
      let actual = grupos[0]?.id ?? "";
      for (const g of grupos) {
        const el = refs.current.get(g.id);
        if (el && el.getBoundingClientRect().top <= ALTO_STICKY + 6) actual = g.id;
      }
      setVisible(actual);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [grupos]);

  function irA(id: string) {
    if (cerradas.has(id)) {
      const s = new Set(cerradas);
      s.delete(id);
      guardar(s);
    }
    const el = refs.current.get(id);
    if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - ALTO_STICKY, behavior: "smooth" });
  }

  return (
    <div>
      <div className="hm-sticky">
        <div className="hm-scroll hm-dias" ref={tira} role="navigation" aria-label="Cambiar de día">
          {dias.map((d) => (
            <a key={d.iso} className="hm-dia" href={d.href} aria-current={d.activo ? "date" : undefined}>
              <span className={`hm-dia__sem${d.esHoy ? " hm-dia__sem--hoy" : ""}`}>{d.esHoy ? "Hoy" : d.semana}</span>
              <span className="hm-dia__num">{d.numero}</span>
              <span className="hm-dia__cant">{d.cantidad} p.</span>
            </a>
          ))}
        </div>
        <div className="hm-scroll hm-filtros">
          <div className="hm-segmentos">
            <a href={hrefTodos} className={`tb-segmento${!soloMios ? " tb-chip--activo" : ""}`} aria-current={!soloMios ? "true" : undefined}>Todos</a>
            <a href={hrefMios} className={`tb-segmento${soloMios ? " tb-chip--activo" : ""}`} aria-current={soloMios ? "true" : undefined}>Mis equipos</a>
          </div>
          {grupos.length > 0 && <span className="hm-sep" aria-hidden="true" />}
          <div className="hm-chips">
            {grupos.map((g) => (
              <button
                key={g.id}
                type="button"
                className={`tb-chip${visible === g.id ? " tb-chip--activo" : ""}`}
                onClick={() => irA(g.id)}
              >
                <span className="hm-chip__nombre">{g.nombre}</span> <b>{g.items.length}</b>
              </button>
            ))}
          </div>
        </div>
      </div>

      {grupos.length === 0 ? (
        <div style={{ padding: 16 }}>
          <div className="tb-vacio">
            <span>{sinMios ? "Ninguno de tus equipos juega este día." : "No hay partidos cargados para este día."}</span>
            {sinMios && (
              <a href={hrefTodos} className="tb-boton tb-boton--primario" style={{ textDecoration: "none" }}>
                Ver todos los partidos
              </a>
            )}
          </div>
        </div>
      ) : (
        <div className="hm-grupos">
          {grupos.map((g) => {
            const cerrada = cerradas.has(g.id);
            return (
              <section
                key={g.id}
                ref={(el) => {
                  if (el) refs.current.set(g.id, el);
                }}
              >
                <button
                  type="button"
                  className="tb-barra tb-barra--rojo hm-barra"
                  aria-expanded={!cerrada}
                  onClick={() => alternar(g.id)}
                >
                  <span>
                    <span className="hm-barra__flecha" aria-hidden="true">{cerrada ? "▸" : "▾"}</span>
                    {g.nombre}
                  </span>
                  <span className="tb-barra__extra">{g.items.length === 1 ? "1 partido" : `${g.items.length} partidos`}</span>
                </button>
                {!cerrada &&
                  g.items.map((m) => (
                    <div key={m.id} className={`hm-partido${m.mio ? " hm-partido--mio" : ""}`}>
                      <a href={`/partidos/${m.id}`} className="hm-partido__hora" style={{ textDecoration: "none" }}>{m.hora}</a>
                      <a href={`/partidos/${m.id}`} className="hm-partido__cuerpo" style={{ textDecoration: "none" }}>
                        <span className="hm-equipo"><Escudo equipo={m.local} /><span>{m.local.nombre}</span></span>
                        <span className="hm-equipo"><Escudo equipo={m.visitante} /><span>{m.visitante.nombre}</span></span>
                        <span className="hm-meta">
                          {m.meta}
                          {m.mio && <b> · ★ Tu equipo</b>}
                        </span>
                      </a>
                      <SincronizarPartido
                        compacto
                        anonimo={anonimo}
                        matchId={m.id}
                        status={m.status}
                        errorMessage={m.errorMessage}
                      />
                    </div>
                  ))}
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
