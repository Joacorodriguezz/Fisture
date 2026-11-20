import { useEffect, useRef, useState } from "react";
import { irALogin } from "../../../lib/auth/client";
import { formatearCodigo } from "../../../lib/prode/reglas";

// Invitación al grupo (docs/37 D16): código grande para dictar, link para WhatsApp y, para quien
// administra, cambiar el código (el link anterior deja de andar).
interface Props {
  grupoId: string;
  nombre: string;
  liga: string;
  codigo: string;
  // Origen público de la app (PUBLIC_APP_URL), para armar el link absoluto
  base: string;
  esAdmin: boolean;
}

export default function InvitarGrupo({ grupoId, nombre, liga, codigo: codigoInicial, base, esAdmin }: Props) {
  const [codigo, setCodigo] = useState(codigoInicial);
  const [puedeCompartir, setPuedeCompartir] = useState(false);
  const [aviso, setAviso] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmando, setConfirmando] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const botonCambiar = useRef<HTMLButtonElement>(null);
  const botonCancelar = useRef<HTMLButtonElement>(null);
  const primeraVez = useRef(true);

  const link = `${base.replace(/\/$/, "")}/prode/unirse/${codigo}`;
  const texto = `Sumate a mi prode «${nombre}» de ${liga} en Fisture. Código: ${formatearCodigo(codigo)}`;

  useEffect(() => {
    setPuedeCompartir(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);

  // Los botones de la confirmación se desmontan: el foco se mueve a mano para no caer en <body>
  useEffect(() => {
    if (primeraVez.current) {
      primeraVez.current = false;
      return;
    }
    (confirmando ? botonCancelar : botonCambiar).current?.focus();
  }, [confirmando]);

  async function copiar() {
    setError(null);
    try {
      await navigator.clipboard.writeText(link);
      setAviso("Link copiado. Pegalo en el grupo de WhatsApp.");
    } catch {
      setAviso(null);
      setError("No se pudo copiar. Mantené apretado el link para copiarlo a mano.");
    }
  }

  async function compartir() {
    setError(null);
    try {
      await navigator.share({ title: `Prode ${nombre}`, text: texto, url: link });
    } catch (e) {
      // Cancelar el menú de compartir no es un error
      if ((e as Error)?.name !== "AbortError") await copiar();
    }
  }

  async function cambiarCodigo() {
    setOcupado(true);
    setError(null);
    try {
      const res = await fetch(`/api/prode/grupos/${grupoId}/codigo`, { method: "POST" });
      if (res.status === 401) return irALogin();
      if (!res.ok) throw new Error("http");
      setCodigo(((await res.json()) as { codigo: string }).codigo);
      setAviso("Código nuevo. El link anterior ya no sirve para sumarse.");
      setConfirmando(false);
    } catch {
      setError("No se pudo cambiar el código. Probá de nuevo.");
      setConfirmando(false);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="pr-caja">
      <h3>Invitá a tu gente</h3>
      <div>
        <p className="tb-meta" id="codigo-titulo">Código del grupo</p>
        <p className="pr-codigo" aria-describedby="codigo-titulo" translate="no">
          {formatearCodigo(codigo)}
        </p>
      </div>
      <p className="pr-link" translate="no">{link}</p>
      <div className="pr-botones">
        {puedeCompartir && (
          <button type="button" className="tb-boton tb-boton--primario" onClick={compartir}>
            Compartir invitación
          </button>
        )}
        <button type="button" className={`tb-boton${puedeCompartir ? "" : " tb-boton--primario"}`} onClick={copiar}>
          Copiar link
        </button>
        <a className="tb-boton" href={`https://wa.me/?text=${encodeURIComponent(`${texto} ${link}`)}`} target="_blank" rel="noopener noreferrer">
          Enviar por WhatsApp
        </a>
      </div>
      <p role="status" className="tb-ok" style={{ margin: 0, minHeight: 16 }}>
        {aviso}
      </p>
      {error && (
        <p className="tb-error" role="alert" style={{ margin: 0 }}>
          {error}
        </p>
      )}
      {esAdmin &&
        (confirmando ? (
          <div className="pr-confirmar" role="group" aria-label="Confirmar: cambiar el código">
            <p>¿Cambiar el código? Quien tenga el link viejo no va a poder sumarse.</p>
            <button type="button" className="tb-boton tb-boton--primario" disabled={ocupado} onClick={cambiarCodigo}>
              {ocupado ? "Cambiando…" : "Sí, cambiar"}
            </button>
            <button ref={botonCancelar} type="button" className="tb-boton" disabled={ocupado} onClick={() => setConfirmando(false)}>
              Cancelar
            </button>
          </div>
        ) : (
          <button ref={botonCambiar} type="button" className="tb-link-boton" style={{ alignSelf: "flex-start" }} onClick={() => setConfirmando(true)}>
            Cambiar el código
          </button>
        ))}
    </div>
  );
}
