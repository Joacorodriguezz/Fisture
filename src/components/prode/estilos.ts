import type { CSSProperties } from "react";

// Estilos compartidos de las islas del prode (identidad Tribuna 90, variables de tribuna90.css).
export const texto: CSSProperties = { font: "400 15px/20px var(--font-texto)" };
export const suave: CSSProperties = { font: "400 14px/19px var(--font-texto)", color: "var(--tinta-suave)" };
export const rotulo: CSSProperties = { font: "700 17px/20px var(--font-rotulo)", textTransform: "uppercase" };
export const fila: CSSProperties = { display: "flex", flexDirection: "column", gap: 10, padding: "16px 12px", borderBottom: "1px solid var(--linea)" };
// Objetivo táctil de al menos 44px
export const campo: CSSProperties = {
  font: "400 16px/22px var(--font-texto)",
  minHeight: 44,
  padding: "8px 10px",
  border: "2px solid var(--tinta)",
  background: "var(--papel)",
  color: "var(--tinta)",
};
export const boton: CSSProperties = { minHeight: 44, minWidth: 44 };
export const aviso = (tipo: "ok" | "error"): CSSProperties => ({
  minHeight: 19,
  font: "400 14px/19px var(--font-texto)",
  color: tipo === "error" ? "var(--alerta, #b00020)" : "var(--tinta-suave)",
});
export const soloLectores: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

// Tarjeta de partido (diseño v3): filete superior de color, siglas y goles con − / +.
export const tarjeta: CSSProperties = { border: "1px solid var(--linea)", background: "var(--papel)", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 12 };
export const etiquetaTarjeta: CSSProperties = { display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: "6px 10px", font: "400 15px/1.2 var(--font-rotulo)", textTransform: "uppercase", letterSpacing: ".06em" };
export const filaEquipo: CSSProperties = { display: "flex", alignItems: "center", gap: 10 };
export const siglaEquipo: CSSProperties = { width: 44, height: 44, flex: "none", border: "2px solid var(--tinta)", display: "flex", alignItems: "center", justifyContent: "center", font: "700 14px/1 var(--font-rotulo)", background: "var(--papel)" };
export const tituloEquipo: CSSProperties = { flex: 1, minWidth: 0, font: "400 clamp(18px,4.5vw,28px)/1 var(--font-titular)", textTransform: "uppercase", overflowWrap: "anywhere" };
export const golBoton: CSSProperties = { width: 40, height: 44, border: "2px solid var(--tinta)", borderRadius: 0, background: "var(--papel)", color: "var(--tinta)", fontSize: 22, fontWeight: 700, cursor: "pointer", padding: 0 };
export const golCampo: CSSProperties = { width: 52, height: 52, border: "2px solid var(--tinta)", borderRadius: 2, background: "var(--papel)", color: "var(--tinta)", font: "400 32px/1 var(--font-titular)", textAlign: "center", padding: 0 };
export const resultadoCerrado: CSSProperties = { width: 56, height: 52, display: "flex", alignItems: "center", justifyContent: "center", font: "400 36px/1 var(--font-titular)", background: "var(--papel-2)", border: "2px solid var(--tinta)" };
export const insignia = (tipo: "alerta" | "oscuro" | "borde"): CSSProperties =>
  tipo === "alerta"
    ? { background: "var(--amarillo)", color: "var(--on-amarillo, var(--tinta))", border: "1px solid var(--tinta)", padding: "1px 8px", fontWeight: 700 }
    : tipo === "oscuro"
      ? { background: "var(--tinta)", color: "var(--papel)", padding: "2px 8px" }
      : { border: "1px solid var(--tinta)", padding: "1px 8px", color: "var(--tinta)" };

// ¿Quién pasa?: dos opciones grandes (radio con el nombre del equipo), alcanzables con el pulgar (docs/40 R6)
export const grupoPasa: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(2,minmax(0,1fr))", gap: 8, margin: 0, padding: 0, border: 0, minWidth: 0 };
export const leyendaPasa: CSSProperties = { padding: 0, marginBottom: 6, font: "400 15px/1.2 var(--font-rotulo)", textTransform: "uppercase", letterSpacing: ".06em" };
export const opcionPasa = (elegida: boolean): CSSProperties => ({
  display: "flex",
  alignItems: "center",
  gap: 10,
  minHeight: 52,
  padding: "8px 12px",
  border: `2px solid ${elegida ? "var(--rojo)" : "var(--tinta)"}`,
  background: elegida ? "var(--papel-2)" : "var(--papel)",
  color: "var(--tinta)",
  font: "700 16px/1.1 var(--font-rotulo)",
  textTransform: "uppercase",
  overflowWrap: "anywhere",
  cursor: "pointer",
});
export const radioPasa: CSSProperties = { flex: "none", width: 22, height: 22, margin: 0, accentColor: "var(--rojo)" };
