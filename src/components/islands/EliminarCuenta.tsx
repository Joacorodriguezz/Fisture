import { useRef, useState } from "react";

interface Props {
  email: string;
  provider: "google" | "microsoft" | string;
}

// Zona de peligro de Configuración: borra la cuenta tras escribir el email para confirmar.
// El servidor vuelve a validar la confirmación (docs/14-borrado-de-cuenta-tdd.md).
export default function EliminarCuenta({ email, provider }: Props) {
  const dialogo = useRef<HTMLDialogElement>(null);
  const [confirmacion, setConfirmacion] = useState("");
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const coincide = confirmacion.trim().toLowerCase() === email.toLowerCase();

  function abrir() {
    setConfirmacion("");
    setError(null);
    dialogo.current?.showModal();
  }

  function cerrar() {
    if (ocupado) return;
    dialogo.current?.close();
  }

  async function eliminar() {
    if (!coincide || ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch("/api/cuenta", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirmar: confirmacion.trim() }),
      });
      if (!res.ok) throw new Error("delete failed");
      location.href = "/?cuenta=eliminada";
    } catch {
      setError("No se pudo eliminar la cuenta. Probá de nuevo.");
      setOcupado(false);
    }
  }

  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "12px 16px", padding: "16px 12px", borderBottom: "1px solid var(--linea)" }}>
      <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 2 }}>
        <span style={{ font: "700 17px/20px var(--font-rotulo)", textTransform: "uppercase" }}>Eliminar mi cuenta</span>
        <span style={{ font: "400 14px/19px var(--font-texto)", color: "var(--tinta-suave)" }}>
          Borra tu usuario, tus equipos y tus preferencias. No se puede deshacer.
        </span>
      </div>
      <button type="button" className="tb-boton" onClick={abrir}>
        Eliminar mi cuenta
      </button>

      <dialog
        ref={dialogo}
        aria-labelledby="eliminar-cuenta-titulo"
        onCancel={(e) => {
          if (ocupado) e.preventDefault();
        }}
        style={{ maxWidth: 520, width: "calc(100% - 32px)", boxSizing: "border-box", padding: 24, border: "4px solid var(--tinta)", background: "var(--papel)", color: "var(--tinta)" }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <h2 id="eliminar-cuenta-titulo" style={{ margin: 0, font: "400 28px/1.05 var(--font-titular)", textTransform: "uppercase" }}>
            ¿Eliminar tu cuenta?
          </h2>
          <p style={{ margin: 0, font: "400 15px/22px var(--font-texto)" }}>
            Se borran ahora mismo tu usuario, los equipos que seguís, tus preferencias y el registro de partidos sincronizados. No hay período de gracia.
          </p>
          <p style={{ margin: 0, font: "400 15px/22px var(--font-texto)" }}>
            Los eventos que ya están en tu calendario <strong>no se borran</strong>: quedan ahí y los podés quitar vos.
            {provider === "google"
              ? " Vamos a revocar el acceso de FISTURE a tu cuenta de Google."
              : " Para quitar el permiso de FISTURE en Microsoft, revocalo en account.live.com/consent/Manage."}
          </p>
          <label style={{ display: "flex", flexDirection: "column", gap: 6, font: "700 14px/18px var(--font-rotulo)", textTransform: "uppercase" }}>
            Escribí tu email para confirmar ({email})
            <input
              type="email"
              autoComplete="off"
              value={confirmacion}
              onChange={(e) => setConfirmacion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  eliminar();
                }
              }}
              style={{ font: "400 16px/22px var(--font-texto)", padding: "10px 12px", border: "2px solid var(--tinta)", textTransform: "none" }}
            />
          </label>
          {error && (
            <span role="alert" className="tb-error">
              {error}
            </span>
          )}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
            <button type="button" className="tb-boton tb-boton--primario" disabled={!coincide || ocupado} onClick={eliminar}>
              {ocupado ? "Eliminando…" : "Eliminar definitivamente"}
            </button>
            <button type="button" className="tb-boton" disabled={ocupado} onClick={cerrar}>
              Cancelar
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
