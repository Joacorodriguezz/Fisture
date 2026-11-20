import { useEffect, useRef, useState } from "react";
import { irALogin } from "../../../lib/auth/client";

// Miembros del grupo y acciones con confirmación en dos pasos (docs/37 D8): quien administra saca
// miembros y borra el grupo; cualquiera sale. Los ids solo viajan en el HTML de quien administra.
export interface MiembroVista {
  // Solo para quien administra (para sacar); para el resto, una clave de lista
  id: string;
  nombre: string;
  organiza: boolean;
  esVos: boolean;
}

interface Props {
  grupoId: string;
  nombre: string;
  miembros: MiembroVista[];
  esAdmin: boolean;
}

type Confirmacion = { tipo: "sacar"; miembro: MiembroVista } | { tipo: "salir" } | { tipo: "borrar" } | null;

export default function GestionGrupo({ grupoId, nombre, miembros: inicial, esAdmin }: Props) {
  const [miembros, setMiembros] = useState(inicial);
  const [confirmando, setConfirmando] = useState<Confirmacion>(null);
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const cancelar = useRef<HTMLButtonElement>(null);
  const titulo = useRef<HTMLHeadingElement>(null);

  // Al abrir una confirmación, el foco va a «Cancelar» (la opción segura); al cerrarla, al título
  const abierta = confirmando !== null;
  const primeraVez = useRef(true);
  useEffect(() => {
    if (primeraVez.current) {
      primeraVez.current = false;
      return;
    }
    (abierta ? cancelar : titulo).current?.focus();
  }, [abierta]);

  const otros = miembros.filter((m) => !m.esVos);

  async function ejecutar(url: string, method: "POST" | "DELETE"): Promise<Response | null> {
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch(url, { method });
      if (res.status === 401) {
        irALogin();
        return null;
      }
      if (!res.ok) throw new Error("http");
      return res;
    } catch {
      setError("No se pudo completar. Revisá la conexión y probá de nuevo.");
      return null;
    } finally {
      setOcupado(false);
    }
  }

  async function confirmar() {
    if (!confirmando) return;
    if (confirmando.tipo === "sacar") {
      const m = confirmando.miembro;
      if (await ejecutar(`/api/prode/grupos/${grupoId}/miembros/${encodeURIComponent(m.id)}`, "DELETE")) {
        setMiembros((prev) => prev.filter((x) => x.id !== m.id));
        setAviso(`${m.nombre} ya no está en el grupo.`);
      }
      setConfirmando(null);
    } else if (confirmando.tipo === "salir") {
      if (await ejecutar(`/api/prode/grupos/${grupoId}/salir`, "POST")) location.href = "/prode?aviso=salida";
      else setConfirmando(null);
    } else {
      if (await ejecutar(`/api/prode/grupos/${grupoId}`, "DELETE")) location.href = "/prode?aviso=borrado";
      else setConfirmando(null);
    }
  }

  const textoConfirmacion = !confirmando
    ? ""
    : confirmando.tipo === "sacar"
      ? `¿Sacar a ${confirmando.miembro.nombre} del grupo? Puede volver a sumarse con el link mientras no cambies el código.`
      : confirmando.tipo === "borrar"
        ? `¿Borrar «${nombre}»? Se borra para todos. Los pronósticos de cada uno no se pierden.`
        : otros.length === 0
          ? "Sos el único del grupo: si salís, el grupo se borra."
          : esAdmin
            ? `¿Salir del grupo? Lo va a administrar ${otros[0].nombre}.`
            : "¿Salir del grupo? Podés volver con el link mientras no cambien el código.";

  return (
    <div className="pr-caja">
      <h3 ref={titulo} tabIndex={-1}>
        {miembros.length === 1 ? "1 jugador" : `${miembros.length} jugadores`}
      </h3>
      <ul className="pr-miembros">
        {miembros.map((m) => (
          <li key={m.id}>
            <span>
              {m.nombre}
              {m.esVos && <span className="pr-vos">Vos</span>}
            </span>
            <span className="pr-botones">
              {m.organiza && <span className="pr-rol">Organiza</span>}
              {esAdmin && !m.esVos && (
                <button type="button" className="tb-link-boton" disabled={ocupado || abierta} onClick={() => setConfirmando({ tipo: "sacar", miembro: m })} aria-label={`Sacar a ${m.nombre} del grupo`}>
                  Sacar
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      <p role="status" className="tb-ok" style={{ margin: 0, minHeight: 16 }}>
        {aviso}
      </p>

      {confirmando ? (
        <div className="pr-confirmar" role="group" aria-label="Confirmar la acción">
          <p>{textoConfirmacion}</p>
          <button type="button" className="tb-boton tb-boton--primario" disabled={ocupado} onClick={confirmar}>
            {ocupado ? "Un momento…" : confirmando.tipo === "sacar" ? "Sí, sacar" : confirmando.tipo === "borrar" ? "Sí, borrar el grupo" : "Sí, salir"}
          </button>
          <button ref={cancelar} type="button" className="tb-boton" disabled={ocupado} onClick={() => setConfirmando(null)}>
            Cancelar
          </button>
        </div>
      ) : (
        <div className="pr-botones">
          <button type="button" className="tb-boton" onClick={() => setConfirmando({ tipo: "salir" })}>
            Salir del grupo
          </button>
          {esAdmin && (
            <button type="button" className="tb-boton tb-boton--tinta" onClick={() => setConfirmando({ tipo: "borrar" })}>
              Borrar el grupo
            </button>
          )}
        </div>
      )}
      {error && (
        <p className="tb-error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </div>
  );
}
