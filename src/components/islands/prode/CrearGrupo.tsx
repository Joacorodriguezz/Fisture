import { useId, useRef, useState } from "react";
import { irALogin } from "../../../lib/auth/client";
import { NOMBRE_MAX, NOMBRE_MIN, normalizarNombreGrupo } from "../../../lib/prode/reglas";

// Crear un grupo del prode (docs/37 §3.3): nombre y competencia. Al crearlo se va directo a invitar
// (pestaña Grupo), que es el paso siguiente natural del organizador.
interface Props {
  ligas: { id: string; nombre: string }[];
}

const MENSAJES: Record<string, string> = {
  nombre_invalido: `El nombre tiene que tener entre ${NOMBRE_MIN} y ${NOMBRE_MAX} caracteres.`,
  liga_invalida: "Elegí una competencia de la lista.",
  limite_grupos: "Ya estás en 20 grupos: salí de alguno para crear otro.",
  rate_limited: "Creaste muchos grupos seguidos. Esperá un rato y probá de nuevo.",
};

export default function CrearGrupo({ ligas }: Props) {
  const id = useId();
  const [nombre, setNombre] = useState("");
  const [liga, setLiga] = useState(ligas[0]?.id ?? "");
  const [ocupado, setOcupado] = useState(false);
  const [errorNombre, setErrorNombre] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const campoNombre = useRef<HTMLInputElement>(null);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!normalizarNombreGrupo(nombre)) {
      setErrorNombre(MENSAJES.nombre_invalido);
      campoNombre.current?.focus();
      return;
    }
    setErrorNombre(null);
    setOcupado(true);
    try {
      const res = await fetch("/api/prode/grupos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre, ligaId: liga }),
      });
      if (res.status === 401) return irALogin();
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (res.ok && body.id) {
        location.href = `/prode/${body.id}?tab=grupo&aviso=creado`;
        return;
      }
      if (body.error === "nombre_invalido") {
        setErrorNombre(MENSAJES.nombre_invalido);
        campoNombre.current?.focus();
      } else setError(MENSAJES[body.error ?? ""] ?? "No se pudo crear el grupo. Probá de nuevo.");
      setOcupado(false);
    } catch {
      setError("No se pudo crear el grupo. Revisá la conexión y probá de nuevo.");
      setOcupado(false);
    }
  }

  return (
    <form className="pr-caja" onSubmit={crear} noValidate aria-labelledby={`${id}-titulo`}>
      <h3 id={`${id}-titulo`}>Crear un grupo</h3>
      <div className="pr-campo">
        <label htmlFor={`${id}-nombre`}>Nombre del grupo</label>
        <input
          ref={campoNombre}
          id={`${id}-nombre`}
          type="text"
          autoComplete="off"
          maxLength={NOMBRE_MAX}
          placeholder="Los del Cinco"
          value={nombre}
          aria-invalid={errorNombre ? true : undefined}
          aria-describedby={`${id}-ayuda-nombre`}
          onChange={(e) => setNombre(e.target.value)}
        />
        <small id={`${id}-ayuda-nombre`} className={errorNombre ? "tb-error" : undefined}>
          {errorNombre ?? "Lo ven todos los que se sumen."}
        </small>
      </div>
      <div className="pr-campo">
        <label htmlFor={`${id}-liga`}>Competencia</label>
        <select id={`${id}-liga`} value={liga} onChange={(e) => setLiga(e.target.value)} aria-describedby={`${id}-ayuda-liga`}>
          {ligas.map((l) => (
            <option key={l.id} value={l.id}>
              {l.nombre}
            </option>
          ))}
        </select>
        <small id={`${id}-ayuda-liga`}>Se pronostican sus partidos desde hoy.</small>
      </div>
      <button type="submit" className="tb-boton tb-boton--primario" disabled={ocupado || ligas.length === 0}>
        {ocupado ? "Creando…" : "Crear grupo"}
      </button>
      {error && (
        <p className="tb-error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
    </form>
  );
}
