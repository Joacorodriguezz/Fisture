import { useEffect, useRef, useState } from "react";

interface Props {
  provider: "google" | "microsoft";
  etiqueta: string;
}

// Desvincula un proveedor de la cuenta (docs/18 D9). El servidor vuelve a validar sesión, Origin y reglas.
export default function DesvincularProveedor({ provider, etiqueta }: Props) {
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  // Los botones de la confirmación se desmontan: el foco se mueve a mano para no caer en <body>.
  const botonDisparador = useRef<HTMLButtonElement>(null);
  const botonCancelar = useRef<HTMLButtonElement>(null);
  const primeraVez = useRef(true);

  useEffect(() => {
    if (primeraVez.current) {
      primeraVez.current = false;
      return;
    }
    (confirmando ? botonCancelar : botonDisparador).current?.focus();
  }, [confirmando]);

  async function desvincular() {
    if (ocupado) return;
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch(`/api/auth/identidades/${provider}`, { method: "DELETE" });
      if (!res.ok) throw new Error("unlink failed");
      location.href = "/configuracion";
    } catch {
      setError("No se pudo desvincular. Probá de nuevo.");
      setOcupado(false);
      setConfirmando(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
      {confirmando ? (
        <span role="group" aria-label={`Confirmar: desvincular ${etiqueta}`} style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <span style={{ font: "700 14px/18px var(--font-rotulo)", textTransform: "uppercase" }}>
            ¿Desvincular {etiqueta}? Ya no vas a poder entrar con esa cuenta.
          </span>
          <button type="button" className="tb-boton tb-boton--primario" onClick={desvincular} disabled={ocupado}>
            {ocupado ? "Desvinculando…" : "Sí, desvincular"}
          </button>
          <button ref={botonCancelar} type="button" className="tb-boton" onClick={() => setConfirmando(false)} disabled={ocupado}>
            Cancelar
          </button>
        </span>
      ) : (
        <button ref={botonDisparador} type="button" className="tb-boton" onClick={() => setConfirmando(true)}>
          Desvincular
        </button>
      )}
      {error && (
        <span role="alert" style={{ font: "400 14px/19px var(--font-texto)", color: "var(--rojo-fondo)" }}>
          {error}
        </span>
      )}
    </span>
  );
}
