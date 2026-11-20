import { useEffect, useState } from "react";
import { aviso, boton, campo, fila, rotulo, suave, texto } from "../prode/estilos";
import { enlaceInvitacion, mensajeDeError } from "../prode/logica";

interface GrupoResumen {
  id: string;
  name: string;
  esDueno: boolean;
  integrantes: number;
}

interface GrupoDetalle {
  id: string;
  name: string;
  esDueno: boolean;
  inviteCode?: string;
  integrantes: { nombre: string; esDueno: boolean; esVos: boolean }[];
}

interface Props {
  // Con id muestra el detalle de ese grupo; sin id, la lista y el formulario para crear uno
  grupoId?: string;
}

export default function ProdeGrupos({ grupoId }: Props) {
  return grupoId ? <Detalle id={grupoId} /> : <Lista />;
}

function Lista() {
  const [grupos, setGrupos] = useState<GrupoResumen[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nombre, setNombre] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [mensaje, setMensaje] = useState<string | null>(null);

  useEffect(() => {
    let vivo = true;
    fetch("/api/prode/grupos")
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as { grupos?: GrupoResumen[]; error?: string };
        if (!vivo) return;
        if (!res.ok || !Array.isArray(data.grupos)) setError(mensajeDeError(res.status, data.error, "grupo"));
        else setGrupos(data.grupos);
      })
      .catch(() => vivo && setError("No se pudieron cargar tus grupos. Probá de nuevo."));
    return () => {
      vivo = false;
    };
  }, []);

  async function crear(e: React.FormEvent) {
    e.preventDefault();
    if (ocupado) return;
    setOcupado(true);
    setMensaje(null);
    try {
      const res = await fetch("/api/prode/grupos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre }),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !data.id) {
        setMensaje(mensajeDeError(res.status, data.error, "grupo"));
        return;
      }
      window.location.assign(`/prode/grupos/${encodeURIComponent(data.id)}`);
    } catch {
      setMensaje("No se pudo crear el grupo. Probá de nuevo.");
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div>
      <form noValidate onSubmit={crear} style={{ ...fila, margin: "16px 0", border: "2px solid var(--tinta)", padding: 16 }}>
        <label htmlFor="grupo-nombre" style={rotulo}>Nuevo grupo</label>
        <span id="grupo-nombre-ayuda" style={suave}>Entre 3 y 40 caracteres. Después compartís el enlace de invitación.</span>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          <input
            id="grupo-nombre"
            type="text"
            value={nombre}
            maxLength={80}
            autoComplete="off"
            aria-describedby="grupo-nombre-ayuda grupo-nombre-mensaje"
            aria-invalid={mensaje !== null}
            onChange={(e) => setNombre(e.target.value)}
            style={{ ...campo, flex: 1, minWidth: 200 }}
          />
          <button type="submit" className="tb-boton tb-boton--primario" disabled={ocupado} style={boton}>
            {ocupado ? "Creando…" : "Crear grupo"}
          </button>
        </div>
        <span id="grupo-nombre-mensaje" role="alert" style={aviso("error")}>{mensaje ?? ""}</span>
      </form>

      <h2 style={{ ...rotulo, padding: "16px 12px 4px", margin: 0 }}>Mis grupos</h2>
      {error ? (
        <p role="alert" style={{ ...texto, padding: 12, color: "var(--alerta, #b00020)" }}>{error}</p>
      ) : !grupos ? (
        <p role="status" style={{ ...suave, padding: 12 }}>Cargando grupos…</p>
      ) : grupos.length === 0 ? (
        <p style={{ ...suave, padding: 12 }}>Todavía no estás en ningún grupo. Creá uno o abrí un enlace de invitación.</p>
      ) : (
        <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
          {grupos.map((g) => (
            <li key={g.id} style={{ borderBottom: "1px solid var(--linea)" }}>
              <a href={`/prode/grupos/${encodeURIComponent(g.id)}`} style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 6, minHeight: 44, padding: "12px", color: "inherit", textDecoration: "none" }}>
                <span style={rotulo}>{g.name}</span>
                <span style={suave}>
                  {g.integrantes} {g.integrantes === 1 ? "integrante" : "integrantes"}
                  {g.esDueno ? " · Dueño" : ""}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Detalle({ id }: { id: string }) {
  const [grupo, setGrupo] = useState<GrupoDetalle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiado, setCopiado] = useState<"ok" | "error" | null>(null);

  useEffect(() => {
    let vivo = true;
    fetch(`/api/prode/grupos/${encodeURIComponent(id)}`)
      .then(async (res) => {
        const data = (await res.json().catch(() => ({}))) as GrupoDetalle & { error?: string };
        if (!vivo) return;
        if (res.status === 404) setError("No encontramos ese grupo o no sos integrante.");
        else if (!res.ok || !Array.isArray(data.integrantes)) setError(mensajeDeError(res.status, data.error, "grupo"));
        else setGrupo(data);
      })
      .catch(() => vivo && setError("No se pudo cargar el grupo. Probá de nuevo."));
    return () => {
      vivo = false;
    };
  }, [id]);

  async function copiar(enlace: string) {
    try {
      await navigator.clipboard.writeText(enlace);
      setCopiado("ok");
    } catch {
      setCopiado("error");
    }
  }

  if (error) return <p role="alert" style={{ ...texto, padding: 16, color: "var(--alerta, #b00020)" }}>{error}</p>;
  if (!grupo) return <p role="status" style={{ ...suave, padding: 16 }}>Cargando grupo…</p>;

  const enlace = grupo.inviteCode ? enlaceInvitacion(window.location.origin, grupo.inviteCode) : null;

  return (
    <div>
      <h2 style={{ ...rotulo, padding: "16px 12px 4px", margin: 0 }}>{grupo.name}</h2>
      {enlace && (
        <div style={fila}>
          <label htmlFor="grupo-enlace" style={rotulo}>Enlace de invitación</label>
          <span style={suave}>Quien lo abra, con sesión iniciada, entra al grupo. Compartilo solo con quienes quieras.</span>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
            <input id="grupo-enlace" readOnly value={enlace} onFocus={(e) => e.currentTarget.select()} style={{ ...campo, flex: 1, minWidth: 200 }} />
            <button type="button" className="tb-boton" onClick={() => copiar(enlace)} style={boton}>Copiar enlace</button>
          </div>
          <span role="status" aria-live="polite" style={aviso(copiado === "error" ? "error" : "ok")}>
            {copiado === "ok" ? "Enlace copiado." : copiado === "error" ? "No se pudo copiar. Seleccionalo y copialo a mano." : ""}
          </span>
        </div>
      )}
      <h3 style={{ ...rotulo, padding: "16px 12px 4px", margin: 0 }}>Integrantes ({grupo.integrantes.length})</h3>
      <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
        {grupo.integrantes.map((i, n) => (
          <li key={n} style={{ ...texto, display: "flex", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--linea)", fontWeight: i.esVos ? 700 : 400 }}>
            <span>{i.nombre}{i.esVos ? " (vos)" : ""}</span>
            {i.esDueno && <span style={suave}>Dueño</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
