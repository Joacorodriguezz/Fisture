import { useEffect, useState } from "react";
import { MENSAJES_NOMBRE, NOMBRE_MAX, validarNombreVisible } from "../../lib/prode/nombre-visible";

interface Props {
  inicial: string | null;
}

// Nombre visible del prode: lo único que ven los demás en posiciones y grupos.
// La validación se repite en el servidor (PUT /api/prode/nombre-visible).
export default function NombreVisible({ inicial }: Props) {
  const [guardado, setGuardado] = useState(inicial);
  const [valor, setValor] = useState(inicial ?? "");
  const [hidratado, setHidratado] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [mensaje, setMensaje] = useState<{ tipo: "ok" | "error"; texto: string } | null>(null);

  useEffect(() => setHidratado(true), []);

  async function guardar(e: React.FormEvent) {
    e.preventDefault();
    if (ocupado) return;
    const local = validarNombreVisible(valor);
    if (!local.ok) {
      setMensaje({ tipo: "error", texto: MENSAJES_NOMBRE[local.error] });
      return;
    }
    setOcupado(true);
    setMensaje(null);
    try {
      const res = await fetch("/api/prode/nombre-visible", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ nombre: local.nombre }),
      });
      const data = (await res.json().catch(() => ({}))) as { nombre?: string; error?: string };
      if (!res.ok || !data.nombre) {
        setMensaje({ tipo: "error", texto: res.status === 429 ? "Demasiados intentos. Esperá un minuto." : data.error ?? "No se pudo guardar. Probá de nuevo." });
        return;
      }
      setGuardado(data.nombre);
      setValor(data.nombre);
      setMensaje({ tipo: "ok", texto: "Nombre guardado." });
    } catch {
      setMensaje({ tipo: "error", texto: "No se pudo guardar. Probá de nuevo." });
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form
      noValidate
      onSubmit={guardar}
      style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-end", gap: "12px 16px", padding: "16px 12px", borderBottom: "1px solid var(--linea)" }}
    >
      <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="nombre-visible" style={{ font: "700 17px/20px var(--font-rotulo)", textTransform: "uppercase" }}>
          Nombre en el prode
        </label>
        <span id="nombre-visible-ayuda" style={{ font: "400 14px/19px var(--font-texto)", color: "var(--tinta-suave)" }}>
          {guardado ? "Es lo único que ven los demás en las posiciones." : "Elegí cómo te van a ver en las posiciones antes de participar. Nunca mostramos tu email."}
        </span>
        <input
          id="nombre-visible"
          type="text"
          value={valor}
          disabled={!hidratado}
          maxLength={NOMBRE_MAX * 2}
          autoComplete="nickname"
          aria-describedby="nombre-visible-ayuda nombre-visible-mensaje"
          aria-invalid={mensaje?.tipo === "error"}
          onChange={(e) => setValor(e.target.value)}
          style={{ font: "400 16px/22px var(--font-texto)", padding: "8px 10px", border: "2px solid var(--tinta)", background: "var(--papel)", color: "var(--tinta)" }}
        />
        <span id="nombre-visible-mensaje" role="status" style={{ minHeight: 19, font: "400 14px/19px var(--font-texto)", color: mensaje?.tipo === "error" ? "var(--alerta, #b00020)" : "var(--tinta-suave)" }}>
          {mensaje?.texto ?? ""}
        </span>
      </div>
      <button type="submit" className="tb-boton" disabled={!hidratado || ocupado}>
        {ocupado ? "Guardando…" : guardado ? "Cambiar nombre" : "Guardar nombre"}
      </button>
    </form>
  );
}
